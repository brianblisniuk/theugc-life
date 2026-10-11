/**
 * Cross-tenant negative tests for pipeline_items.
 *
 * User A must never read, update, or enumerate User B's private
 * pipeline resources, even with direct IDs.
 *
 * Uses the shared Postgres harness (tests/db/harness.ts).
 * Skips when TEST_DATABASE_URL is unset.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const HOTEL = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!hasTestDb)("Pipeline tenant isolation", () => {
  let itemB: string;

  beforeAll(async () => {
    await setupDatabase();

    await adminQuery(`
      insert into auth.users (id) values ($1), ($2);
      insert into public.creator_profiles (id, user_id) values
        (gen_random_uuid(), $1),
        (gen_random_uuid(), $2);
      insert into public.hotels (id, name, destination_id, country_code)
        values ($3, 'Test Hotel', null, 'US');
    `, [USER_A, USER_B, HOTEL]);

    const [row] = await adminQuery<{ id: string }>(`
      insert into public.pipeline_items (creator_id, hotel_id, status, private_notes)
      select cp.id, $2, 'saved', 'secret notes of B'
        from public.creator_profiles cp
       where cp.user_id = $1
      returning id
    `, [USER_B, HOTEL]);
    itemB = row.id;
  });

  afterAll(async () => {
    await teardownDatabase();
  });

  it("User A cannot read User B pipeline item by direct ID", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USER_A },
      `select id, private_notes from public.pipeline_items where id = $1`,
      [itemB],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(0);
  });

  it("User A cannot list any of User B items", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USER_A },
      `select id from public.pipeline_items`,
    );
    expect(res.error).toBeNull();
    expect(res.rows.every((r: { id: string }) => r.id !== itemB)).toBe(true);
  });

  it("User A cannot update User B private_notes", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USER_A },
      `update public.pipeline_items set private_notes = 'hacked' where id = $1 returning id`,
      [itemB],
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(0);

    const [still] = await adminQuery<{ private_notes: string }>(
      `select private_notes from public.pipeline_items where id = $1`,
      [itemB],
    );
    expect(still.private_notes).toBe("secret notes of B");
  });

  it("RPC update_pipeline_private_notes rejects User A on User B item", async () => {
    const res = await queryAs(
      { role: "service_role" },
      `select public.update_pipeline_private_notes($1, $2, 'attempt')`,
      [USER_A, itemB],
    );
    expect(res.error).toBeNull();
    const payload = res.rows[0] as { update_pipeline_private_notes: { result: string } };
    expect(payload.update_pipeline_private_notes.result).toBe("not_found_or_forbidden");
  });
});
