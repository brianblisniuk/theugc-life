/**
 * grant_access_entitlement (0042 + 0043 + 0075 + BASE-N9 0094) against real Postgres.
 *
 * Negative controls (each was checked by temporarily reverting the guard):
 *  - without ON CONFLICT DO NOTHING (0042 behaviour) the concurrent test gets a
 *    unique_violation (23505) instead of `already_granted`;
 *  - without the identity match on replay, the mismatch tests receive
 *    `already_granted` and the other user's entitlement id;
 *  - without the p_source check, the null-source test inserts two rows;
 *  - without the revoke from anon/authenticated, the execute tests fail;
 *  - without the null-reference lock and replay, two identical null references
 *    insert two rows;
 *  - without the expires check, expires_at before starts_at inserts a row.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

type WindowArgs = [string, string, string | null, string | null, string | null];

async function grantWindow(
  args: WindowArgs,
  starts: string | null,
  expires: string | null,
): Promise<Res> {
  const s = await openSession("service_role");
  try {
    const r = await s.query<{ res: Res }>(
      "select public.grant_access_entitlement($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz) as res",
      [...args, starts, expires],
    );
    await closeSession(s, "commit");
    return r.rows[0]!.res;
  } catch (e) {
    await closeSession(s, "rollback");
    throw e;
  }
}

async function nullRefRows(source: string, userId?: string) {
  return adminQuery<{ id: string; user_id: string; status: string }>(
    `select id, user_id, status
       from public.access_entitlements
      where source = $1
        and source_reference is null
        and ($2::uuid is null or user_id = $2::uuid)`,
    [source, userId ?? null],
  );
}

d("grant_access_entitlement — BASE-N9 null reference and expiry", () => {
  it("two identical null-reference grants insert one row and the second is already_granted", async () => {
    const source = `null-ref-${randomUUID()}`;
    const a = await grantWindow([USERS.free, "pro", null, source, null], null, null);
    expect(a.result).toBe("granted");
    const b = await grantWindow([USERS.free, "pro", null, source, null], null, null);
    expect(b).toEqual({ result: "already_granted", entitlement_id: a.entitlement_id });
    const rows = await nullRefRows(source);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.entitlement_id);
    expect(rows[0]!.status).toBe("active");
  });

  it("a null-reference replay does not change the stored expiry", async () => {
    const source = `null-ref-${randomUUID()}`;
    const first = await grantWindow(
      [USERS.free, "pro", null, source, null],
      "2024-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
    );
    expect(first.result).toBe("granted");
    const replay = await grantWindow(
      [USERS.free, "pro", null, source, null],
      "2024-01-01T00:00:00Z",
      "2026-06-01T00:00:00Z",
    );
    expect(replay).toEqual({ result: "already_granted", entitlement_id: first.entitlement_id });
    const stored = await adminQuery<{ same: boolean }>(
      `select expires_at = timestamptz '2025-01-01+00' as same
         from public.access_entitlements
        where id = $1`,
      [first.entitlement_id],
    );
    expect(stored[0]!.same).toBe(true);
    expect(await nullRefRows(source)).toHaveLength(1);
  });

  it("a revoked null-reference row is the same logical grant and is not replaced", async () => {
    const source = `null-ref-${randomUUID()}`;
    const seeded = await adminQuery<{ id: string }>(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, source, source_reference, status)
       values ($1, 'pro', null, $2, null, 'revoked')
       returning id`,
      [USERS.free, source],
    );
    const replay = await grantWindow([USERS.free, "pro", null, source, null], null, null);
    expect(replay).toEqual({ result: "already_granted", entitlement_id: seeded[0]!.id });
    const rows = await nullRefRows(source);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("revoked");
  });

  it("two concurrent null-reference deliveries insert one row", async () => {
    const source = `null-ref-${randomUUID()}`;
    const s1 = await openSession("service_role");
    const s2 = await openSession("service_role");
    const sql = "select public.grant_access_entitlement($1, $2, $3, $4, $5, now(), null) as res";
    const args = [USERS.free, "destination", DEST.bali, source, null];
    try {
      const r1 = await s1.query<{ res: Res }>(sql, args);
      const p2 = s2.query<{ res: Res }>(sql, args);
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
    expect(await nullRefRows(source)).toHaveLength(1);
  });

  it("another user, source, or destination is a different null-reference grant", async () => {
    const source = `null-ref-${randomUUID()}`;
    const otherSource = `null-ref-${randomUUID()}`;
    const a = await grantWindow([USERS.free, "pro", null, source, null], null, null);
    const otherUser = await grantWindow([USERS.expired, "pro", null, source, null], null, null);
    const otherSrc = await grantWindow([USERS.free, "pro", null, otherSource, null], null, null);
    const bali = await grantWindow(
      [USERS.free, "destination", DEST.bali, source, null],
      null,
      null,
    );
    const ibiza = await grantWindow(
      [USERS.free, "destination", DEST.ibiza, source, null],
      null,
      null,
    );
    for (const row of [a, otherUser, otherSrc, bali, ibiza]) {
      expect(row.result).toBe("granted");
    }
    const ids = [a, otherUser, otherSrc, bali, ibiza].map((row) => row.entitlement_id);
    expect(new Set(ids).size).toBe(5);
    expect(otherUser.entitlement_id).not.toBe(a.entitlement_id);
    expect(await nullRefRows(source, USERS.free)).toHaveLength(3);
    expect(await nullRefRows(source, USERS.expired)).toHaveLength(1);
  });

  it("refuses ambiguous null-reference duplicates and does not insert or return an id", async () => {
    const source = `null-ref-${randomUUID()}`;
    const seeded = await adminQuery<{ id: string }>(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, source, source_reference, status)
       values
         ($1, 'max', null, $2, null, 'active'),
         ($1, 'max', null, $2, null, 'revoked')
       returning id`,
      [USERS.free, source],
    );
    const replay = await grantWindow([USERS.free, "max", null, source, null], null, null);
    expect(replay).toEqual({ result: "ambiguous_null_reference" });
    expect(JSON.stringify(replay)).not.toContain(seeded[0]!.id);
    expect(JSON.stringify(replay)).not.toContain(seeded[1]!.id);
    expect(await nullRefRows(source)).toHaveLength(2);
  });

  it("refuses expires_at strictly before starts_at and inserts nothing", async () => {
    const source = `null-ref-${randomUUID()}`;
    const refused = await grantWindow(
      [USERS.free, "pro", null, source, null],
      "2024-06-01T00:00:00Z",
      "2024-05-31T23:59:59Z",
    );
    expect(refused).toEqual({ result: "invalid_expires_at" });
    expect(await nullRefRows(source)).toHaveLength(0);

    const openEnded = await grantWindow(
      [USERS.free, "pro", null, `${source}-open`, null],
      null,
      "1999-01-01T00:00:00Z",
    );
    expect(openEnded).toEqual({ result: "invalid_expires_at" });
    expect(await nullRefRows(`${source}-open`)).toHaveLength(0);
  });

  it("allows a null expiry and an expiry equal to starts_at", async () => {
    const source = `null-ref-${randomUUID()}`;
    const open = await grantWindow([USERS.free, "pro", null, source, null], null, null);
    expect(open.result).toBe("granted");
    const openStored = await adminQuery<{ expires_at: string | null }>(
      "select expires_at from public.access_entitlements where id = $1",
      [open.entitlement_id],
    );
    expect(openStored[0]!.expires_at).toBeNull();

    const equal = await grantWindow(
      [USERS.free, "max", null, source, null],
      "2024-06-01T00:00:00Z",
      "2024-06-01T00:00:00Z",
    );
    expect(equal.result).toBe("granted");
    expect(await nullRefRows(source)).toHaveLength(2);
  });

  it("a bad expiry does not replay as already_granted and does not add a row", async () => {
    const source = `null-ref-${randomUUID()}`;
    const first = await grantWindow(
      [USERS.free, "pro", null, source, null],
      "2024-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
    );
    expect(first.result).toBe("granted");
    const bad = await grantWindow(
      [USERS.free, "pro", null, source, null],
      "2024-01-01T00:00:00Z",
      "2023-01-01T00:00:00Z",
    );
    expect(bad).toEqual({ result: "invalid_expires_at" });
    expect(JSON.stringify(bad)).not.toContain(first.entitlement_id!);
    expect(await nullRefRows(source)).toHaveLength(1);
  });

  it("keeps non-null source_reference replay and conflict behavior", async () => {
    const ref = `ref-${randomUUID()}`;
    const first = await grant([USERS.free, "pro", null, "manual_or_webhook", ref]);
    expect(first.result).toBe("granted");
    expect(await grant([USERS.free, "pro", null, "manual_or_webhook", ref])).toEqual({
      result: "already_granted",
      entitlement_id: first.entitlement_id,
    });
    const conflict = await grant([USERS.expired, "pro", null, "manual_or_webhook", ref]);
    expect(conflict).toEqual({ result: "source_reference_conflict" });
    expect(JSON.stringify(conflict)).not.toContain(first.entitlement_id!);
    expect(await rowsFor("manual_or_webhook", ref)).toHaveLength(1);

    const maxRef = `ref-${randomUUID()}`;
    expect((await grant([USERS.free, "max", null, "manual_or_webhook", maxRef])).result).toBe(
      "granted",
    );
    expect(
      (await grant([USERS.free, "max", DEST.bali, "manual_or_webhook", `ref-${randomUUID()}`]))
        .result,
    ).toBe("plan_cannot_have_destination");
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
              coalesce(array_to_string(p.proconfig, ','), '') = 'search_path=""' as pinned,
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

type GrantResult =
  | { result: "granted"; entitlementId: string }
  | { result: "already_granted"; entitlementId: string }
  | { result: "source_reference_conflict" }
  | { result: "ambiguous_null_reference" }
  | { result: "error" }
  | { result: "invalid_input" };

type RpcRow = { result?: string; entitlement_id?: string } | null;

/** Maps the RPC jsonb result. A conflict does not forward another row's id. */
function mapGrantRpcResult(row: RpcRow): GrantResult {
  if (row?.result === "granted" && row.entitlement_id) {
    return { result: "granted", entitlementId: row.entitlement_id };
  }
  if (row?.result === "already_granted" && row.entitlement_id) {
    return { result: "already_granted", entitlementId: row.entitlement_id };
  }
  if (row?.result === "source_reference_conflict") return { result: "source_reference_conflict" };
  if (row?.result === "ambiguous_null_reference") return { result: "ambiguous_null_reference" };
  if (
    row?.result === "invalid_input" ||
    row?.result === "source_required" ||
    row?.result === "invalid_access_type" ||
    row?.result === "destination_required" ||
    row?.result === "pro_cannot_have_destination" ||
    row?.result === "plan_cannot_have_destination" ||
    row?.result === "invalid_expires_at"
  ) {
    return { result: "invalid_input" };
  }
  return { result: "error" };
}

describe("mapGrantRpcResult", () => {
  it("never surfaces an id on conflict and maps shape errors to invalid_input", () => {
    expect(
      mapGrantRpcResult({ result: "source_reference_conflict", entitlement_id: "leak" }),
    ).toEqual({
      result: "source_reference_conflict",
    });
    expect(
      mapGrantRpcResult({ result: "ambiguous_null_reference", entitlement_id: "leak" }),
    ).toEqual({ result: "ambiguous_null_reference" });
    for (const r of [
      "source_required",
      "invalid_access_type",
      "destination_required",
      "pro_cannot_have_destination",
      "plan_cannot_have_destination",
      "invalid_expires_at",
    ]) {
      expect(mapGrantRpcResult({ result: r, entitlement_id: "leak" })).toEqual({
        result: "invalid_input",
      });
    }
    expect(mapGrantRpcResult({ result: "granted" })).toEqual({ result: "error" });
    expect(mapGrantRpcResult(null)).toEqual({ result: "error" });
  });
});
