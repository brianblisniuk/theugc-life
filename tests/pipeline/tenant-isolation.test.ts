/**
 * Cross-tenant isolation for private pipeline notes (PR #41, migration 0041).
 *
 * Permanent invariant: authentication != authorization. Runs against real
 * Postgres. `update_pipeline_private_notes` is SECURITY DEFINER and callable
 * only by service_role; the server action passes the SESSION user id, so the
 * function's owner filter is the boundary these tests attack.
 *
 * Negative controls: removing `and creator_id = v_creator_id` from 0041 makes
 * the foreign-update tests fail (B's notes change); removing the
 * `revoke ... from anon, authenticated` makes the execute tests fail.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { closeSession, endTxPool, openSession } from "../db/tx";
import { USERS, seed, type CreatorIds } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);
const SIG = "public.update_pipeline_private_notes(uuid, uuid, text)";

let creators: CreatorIds;
let itemA: string; // owned by USERS.destBali ("A")
let itemB: string; // owned by USERS.pro ("B")

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  // Hosted Supabase gives service_role USAGE on public; the compat shim does not
  // (tests/db/human-review-revocation.test.ts pins that). Mirror production for
  // THIS file only, so the service_role-only RPC can actually be exercised.
  await adminQuery("grant usage on schema public to service_role");
  creators = await seed();
  const rows = await adminQuery<{ id: string; creator_id: string }>(
    "select id, creator_id from public.pipeline_items where creator_id = any($1)",
    [[creators.destBali, creators.pro]],
  );
  itemA = rows.find((r) => r.creator_id === creators.destBali)!.id;
  itemB = rows.find((r) => r.creator_id === creators.pro)!.id;
}, 120_000);

afterAll(async () => {
  await endTxPool();
  await teardownDatabase();
});

/** Call the RPC as service_role, COMMIT, and return its jsonb result. */
async function callCommitted(userId: string, itemId: string, notes: string) {
  const s = await openSession("service_role");
  try {
    const r = await s.query<{ res: unknown }>(
      "select public.update_pipeline_private_notes($1, $2, $3) as res",
      [userId, itemId, notes],
    );
    await closeSession(s, "commit");
    return r.rows[0]!.res;
  } catch (e) {
    await closeSession(s, "rollback");
    throw e;
  }
}

async function notesOf(itemId: string): Promise<string | null> {
  const rows = await adminQuery<{ private_notes: string | null }>(
    "select private_notes from public.pipeline_items where id = $1",
    [itemId],
  );
  return rows[0]!.private_notes;
}

d("update_pipeline_private_notes — tenant isolation", () => {
  it("owner A can update A's own item (positive control)", async () => {
    expect(await callCommitted(USERS.destBali, itemA, "A edited")).toEqual({ result: "updated" });
    expect(await notesOf(itemA)).toBe("A edited");
  });

  it("A cannot update B's item by direct id; B's notes are unchanged", async () => {
    const before = await notesOf(itemB);
    expect(await callCommitted(USERS.destBali, itemB, "pwned by A")).toEqual({
      result: "not_found_or_forbidden",
    });
    expect(await notesOf(itemB)).toBe(before);
  });

  it("B cannot update A's item (other direction); A's notes are unchanged", async () => {
    const before = await notesOf(itemA);
    expect(await callCommitted(USERS.pro, itemA, "pwned by B")).toEqual({
      result: "not_found_or_forbidden",
    });
    expect(await notesOf(itemA)).toBe(before);
  });

  it("foreign and non-existent ids return byte-identical responses (no existence inference)", async () => {
    const foreign = await callCommitted(USERS.destBali, itemB, "x");
    const missing = await callCommitted(USERS.destBali, randomUUID(), "x");
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    // The response carries no row count, id, or owner hint.
    expect(Object.keys(foreign as object)).toEqual(["result"]);
  });

  it("anon cannot execute the function", async () => {
    const res = await queryAs({ role: "anon" }, `select ${SIG.replace(/\(.*\)/, "")}($1,$2,'x')`, [
      USERS.pro,
      itemB,
    ]);
    expect(res.error?.code).toBe("42501");
    const priv = await adminQuery<{ ok: boolean }>(
      "select has_function_privilege('anon', $1, 'EXECUTE') as ok",
      [SIG],
    );
    expect(priv[0]!.ok).toBe(false);
  });

  it("authenticated A cannot execute it, even naming B's user id", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "select public.update_pipeline_private_notes($1, $2, 'x')",
      [USERS.pro, itemB],
    );
    expect(res.error?.code).toBe("42501");
    const priv = await adminQuery<{ ok: boolean }>(
      "select has_function_privilege('authenticated', $1, 'EXECUTE') as ok",
      [SIG],
    );
    expect(priv[0]!.ok).toBe(false);
  });

  it("authenticated A cannot read, enumerate, count, update or delete B's item directly", async () => {
    const asA = { role: "authenticated" as const, sub: USERS.destBali };
    const read = await queryAs<{ id: string }>(
      asA,
      "select id from public.pipeline_items where id = $1",
      [itemB],
    );
    expect(read.error).toBeNull();
    expect(read.rows).toEqual([]);

    const all = await queryAs<{ creator_id: string }>(
      asA,
      "select creator_id from public.pipeline_items",
    );
    expect(all.rows.every((r) => r.creator_id === creators.destBali)).toBe(true);

    const count = await queryAs<{ n: string }>(
      asA,
      "select count(*)::text as n from public.pipeline_items where creator_id = $1",
      [creators.pro],
    );
    expect(count.rows[0]!.n).toBe("0");

    const upd = await queryAs(
      asA,
      "update public.pipeline_items set private_notes = 'x' where id = $1",
      [itemB],
    );
    expect(upd.error?.code).toBe("42501");
    const del = await queryAs(asA, "delete from public.pipeline_items where id = $1", [itemB]);
    expect(del.error?.code).toBe("42501");
  });

  it("A cannot FK-link a new pipeline item into B's workspace", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USERS.destBali },
      "insert into public.pipeline_items (creator_id, hotel_id) select $1, hotel_id from public.pipeline_items limit 1",
      [creators.pro],
    );
    expect(res.error).not.toBeNull();
  });

  it("a user with no creator profile gets creator_profile_missing and changes nothing", async () => {
    const before = await notesOf(itemB);
    expect(await callCommitted(randomUUID(), itemB, "x")).toEqual({
      result: "creator_profile_missing",
    });
    expect(await notesOf(itemB)).toBe(before);
  });
});
