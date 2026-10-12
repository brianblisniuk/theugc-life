/**
 * grant_access_entitlement (0042 + hardening 0043) against real Postgres.
 *
 * Negative controls (each was checked by temporarily reverting the guard):
 *  - without ON CONFLICT DO NOTHING (0042 behaviour) the concurrent test gets a
 *    unique_violation (23505) instead of `already_granted`;
 *  - without the identity match on replay, the mismatch tests receive
 *    `already_granted` and the other user's entitlement id;
 *  - without the p_source check, the null-source test inserts two rows;
 *  - without the revoke from anon/authenticated, the execute tests fail.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mapGrantRpcResult } from "@/lib/billing/grant";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { closeSession, endTxPool, openSession } from "../db/tx";
import { DEST, USERS, seed } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);
const SIG =
  "public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)";
const CALL =
  "select public.grant_access_entitlement($1, $2, $3, $4, $5, now(), now() + interval '30 days') as res";

type Res = { result: string; entitlement_id?: string };

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  // Hosted Supabase gives service_role USAGE on public; the compat shim does not
  // (tests/db/human-review-revocation.test.ts pins that). Mirror production for
  // THIS file only, so the service_role-only RPC can actually be exercised.
  await adminQuery("grant usage on schema public to service_role");
  await seed();
}, 120_000);

afterAll(async () => {
  await endTxPool();
  await teardownDatabase();
});

async function grant(
  args: [string, string, string | null, string | null, string | null],
): Promise<Res> {
  const s = await openSession("service_role");
  try {
    const r = await s.query<{ res: Res }>(CALL, args);
    await closeSession(s, "commit");
    return r.rows[0]!.res;
  } catch (e) {
    await closeSession(s, "rollback");
    throw e;
  }
}

async function rowsFor(source: string, ref: string) {
  return adminQuery<{ id: string; user_id: string }>(
    "select id, user_id from public.access_entitlements where source = $1 and source_reference = $2",
    [source, ref],
  );
}

d("grant_access_entitlement — idempotency", () => {
  it("first call grants, identical replay returns the same id and inserts nothing", async () => {
    const ref = `ref-${randomUUID()}`;
    const a = await grant([USERS.free, "pro", null, "manual_or_webhook", ref]);
    expect(a.result).toBe("granted");
    const b = await grant([USERS.free, "pro", null, "manual_or_webhook", ref]);
    expect(b).toEqual({ result: "already_granted", entitlement_id: a.entitlement_id });
    expect(await rowsFor("manual_or_webhook", ref)).toHaveLength(1);
  });

  it("two concurrent deliveries of the same reference both succeed with ONE row", async () => {
    const ref = `ref-${randomUUID()}`;
    const s1 = await openSession("service_role");
    const s2 = await openSession("service_role");
    try {
      const r1 = await s1.query<{ res: Res }>(CALL, [
        USERS.free,
        "destination",
        DEST.bali,
        "manual_or_webhook",
        ref,
      ]);
      // s2 blocks on s1's uncommitted unique-index entry.
      const p2 = s2.query<{ res: Res }>(CALL, [
        USERS.free,
        "destination",
        DEST.bali,
        "manual_or_webhook",
        ref,
      ]);
      await new Promise((r) => setTimeout(r, 200));
      await s1.query("commit");
      const r2 = await p2;
      await s2.query("commit");
      expect(r1.rows[0]!.res.result).toBe("granted");
      expect(r2.rows[0]!.res).toEqual({
        result: "already_granted",
        entitlement_id: r1.rows[0]!.res.entitlement_id,
      });
    } finally {
      s1.release();
      s2.release();
    }
    expect(await rowsFor("manual_or_webhook", ref)).toHaveLength(1);
  });
});

d("grant_access_entitlement — replay mismatch never grants or leaks", () => {
  const cases: Array<[string, [string, string, string | null]]> = [
    ["different user", [USERS.expired, "pro", null]],
    ["different access type", [USERS.free, "destination", DEST.bali]],
  ];
  for (const [label, [user, type, dest]] of cases) {
    it(`${label}: source_reference_conflict, no id, no new row`, async () => {
      const ref = `ref-${randomUUID()}`;
      const first = await grant([USERS.free, "pro", null, "manual_or_webhook", ref]);
      expect(first.result).toBe("granted");
      const replay = await grant([user, type, dest, "manual_or_webhook", ref]);
      expect(replay).toEqual({ result: "source_reference_conflict" });
      expect(JSON.stringify(replay)).not.toContain(first.entitlement_id!);
      const rows = await rowsFor("manual_or_webhook", ref);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.user_id).toBe(USERS.free);
    });
  }

  it("different destination: source_reference_conflict", async () => {
    const ref = `ref-${randomUUID()}`;
    expect(
      (await grant([USERS.free, "destination", DEST.bali, "manual_or_webhook", ref])).result,
    ).toBe("granted");
    expect(await grant([USERS.free, "destination", DEST.ibiza, "manual_or_webhook", ref])).toEqual({
      result: "source_reference_conflict",
    });
  });
});

d("grant_access_entitlement — input shape", () => {
  it("rejects a null or blank source and inserts nothing", async () => {
    const ref = `ref-${randomUUID()}`;
    expect(await grant([USERS.free, "pro", null, null, ref])).toEqual({
      result: "source_required",
    });
    expect(await grant([USERS.free, "pro", null, "  ", ref])).toEqual({
      result: "source_required",
    });
    const n = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.access_entitlements where source_reference = $1",
      [ref],
    );
    expect(n[0]!.n).toBe("0");
  });

  it("rejects destination without destination_id, pro with one, and unknown types", async () => {
    const ref = () => `ref-${randomUUID()}`;
    expect(
      (await grant([USERS.free, "destination", null, "manual_or_webhook", ref()])).result,
    ).toBe("destination_required");
    expect((await grant([USERS.free, "pro", DEST.bali, "manual_or_webhook", ref()])).result).toBe(
      "pro_cannot_have_destination",
    );
    expect((await grant([USERS.free, "admin", null, "manual_or_webhook", ref()])).result).toBe(
      "invalid_access_type",
    );
    expect((await grant([USERS.free, "free", null, "manual_or_webhook", ref()])).result).toBe(
      "invalid_access_type",
    );
  });
});

d("grant_access_entitlement — privileges", () => {
  it("anon and authenticated cannot execute; service_role can; search_path pinned; SECURITY DEFINER", async () => {
    const rows = await adminQuery<{
      anon: boolean;
      auth: boolean;
      svc: boolean;
      pinned: boolean;
      definer: boolean;
    }>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
              has_function_privilege('service_role', $1, 'EXECUTE') as svc,
              coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public, pg_temp%' as pinned,
              p.prosecdef as definer
         from pg_proc p where p.oid = $1::regprocedure`,
      [SIG],
    );
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true, pinned: true, definer: true });
  });

  it("an authenticated user cannot self-grant Pro", async () => {
    const res = await queryAs({ role: "authenticated", sub: USERS.free }, CALL, [
      USERS.free,
      "pro",
      null,
      "manual_or_webhook",
      `ref-${randomUUID()}`,
    ]);
    expect(res.error?.code).toBe("42501");
    const anon = await queryAs({ role: "anon" }, CALL, [
      USERS.free,
      "pro",
      null,
      "manual_or_webhook",
      "r",
    ]);
    expect(anon.error?.code).toBe("42501");
  });
});

describe("mapGrantRpcResult", () => {
  it("never surfaces an id on conflict and maps shape errors to invalid_input", () => {
    expect(
      mapGrantRpcResult({ result: "source_reference_conflict", entitlement_id: "leak" }),
    ).toEqual({
      result: "source_reference_conflict",
    });
    for (const r of [
      "source_required",
      "invalid_access_type",
      "destination_required",
      "pro_cannot_have_destination",
    ]) {
      expect(mapGrantRpcResult({ result: r })).toEqual({ result: "invalid_input" });
    }
    expect(mapGrantRpcResult({ result: "granted" })).toEqual({ result: "error" });
    expect(mapGrantRpcResult(null)).toEqual({ result: "error" });
  });
});
