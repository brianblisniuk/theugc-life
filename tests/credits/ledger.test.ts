/**
 * F05 ledger, unlock, and isolation.
 *
 * A second connection must see a committed unlock, so the race and the
 * cross-user checks use commitAs. queryAs still rolls back. Changing
 * credit_config is restored before the test returns: this process is one
 * fork and setupDatabase runs once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CREDITS_CONFIG } from "@/lib/credits/config";
import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const DEST = "c05d0000-0000-4000-8000-000000000001";
const A = "c05a0000-0000-4000-8000-000000000001";
const B = "c05b0000-0000-4000-8000-000000000002";
const ADMIN = "c05c0000-0000-4000-8000-000000000003";
const EDITOR = "c05e0000-0000-4000-8000-000000000004";

const HOTEL = {
  fresh: "c05f0000-0000-4000-8000-000000000001",
  second: "c05f0000-0000-4000-8000-000000000002",
  imported: "c05f0000-0000-4000-8000-000000000003",
  missing: "c05f0000-0000-4000-8000-000000000004",
  stale: "c05f0000-0000-4000-8000-000000000005",
  empty: "c05f0000-0000-4000-8000-000000000006",
  race: "c05f0000-0000-4000-8000-000000000007",
  costly: "c05f0000-0000-4000-8000-000000000008",
  report: "c05f0000-0000-4000-8000-000000000009",
} as const;

const IMPORTED_EMAIL = "imported-owner@hotel.test";

interface UnlockRow {
  result: { status: string; email: string | null; balance?: number };
}

async function makeUser(id: string, role: "creator" | "admin" | "editor" = "creator") {
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
    id,
    `${id}@credits.test`,
  ]);
  if (role !== "creator") {
    await adminQuery("update public.users set role = $2 where id = $1", [id, role]);
  }
}

async function makeHotel(id: string, name: string) {
  await adminQuery(
    "insert into public.hotels (id, name, slug, destination_id) values ($1, $2, $3, $4)",
    [id, name, `c05-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, DEST],
  );
}

async function cacheFound(hotelId: string, email: string, source = "owner_import") {
  await adminQuery(
    `insert into public.contact_cache (hotel_id, email, source, status, last_verified_at)
     values ($1, $2, $3, 'found', now())`,
    [hotelId, email, source],
  );
}

async function unlock(userId: string, hotelId: string, key: string) {
  return commitAs<UnlockRow>(
    { role: "authenticated", sub: userId },
    "select public.unlock_hotel_contact($1, $2) as result",
    [hotelId, key],
  );
}

async function balanceOf(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    "select coalesce(sum(delta), 0)::int as n from public.credit_ledger where user_id = $1",
    [userId],
  );
  return rows[0]!.n;
}

async function unlockDeltas(userId: string, hotelId: string): Promise<number[]> {
  const rows = await adminQuery<{ delta: number }>(
    `select delta from public.credit_ledger
      where user_id = $1 and reason = 'unlock' and ref_id = $2
      order by created_at`,
    [userId, hotelId],
  );
  return rows.map((row) => row.delta);
}

d("contact credit ledger", () => {
  beforeAll(async () => {
    await setupDatabase();
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Credit Bay', 'credit-bay', 'city')",
      [DEST],
    );
    await makeUser(A);
    await makeUser(B);
    await makeUser(ADMIN, "admin");
    await makeUser(EDITOR, "editor");
    for (const [key, id] of Object.entries(HOTEL)) {
      await makeHotel(id, `Credit ${key}`);
    }
    await cacheFound(HOTEL.fresh, "fresh@hotel.test");
    await cacheFound(HOTEL.second, "second@hotel.test");
    await cacheFound(HOTEL.race, "race@hotel.test");
    await cacheFound(HOTEL.costly, "costly@hotel.test");
    await cacheFound(HOTEL.report, "report@hotel.test");
    await adminQuery(
      `insert into public.contact_cache (hotel_id, email, source, status, last_verified_at)
       values ($1, null, 'provider', 'not_found', now())`,
      [HOTEL.missing],
    );
    await adminQuery(
      `insert into public.contact_cache (hotel_id, email, source, status, last_verified_at)
       values ($1, 'stale@hotel.test', 'provider', 'found', now() - interval '400 days')`,
      [HOTEL.stale],
    );
    await adminQuery(
      `insert into public.hotel_contacts (hotel_id, first_name, email, status, source_type)
       values ($1, 'Imported', $2, 'active', 'editorial')`,
      [HOTEL.imported, IMPORTED_EMAIL],
    );
    await adminQuery("select public.seed_imported_contact_cache()");
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("grants the configured Free amount once", async () => {
    const rows = await adminQuery<{ delta: number; n: string }>(
      `select delta, count(*)::text as n
         from public.credit_ledger
        where user_id = $1 and reason = 'free_grant' and idempotency_key = 'free_grant:v1'
        group by delta`,
      [A],
    );
    expect(rows).toEqual([{ delta: CREDITS_CONFIG.freeCredits, n: "1" }]);
    await adminQuery("select public.grant_free_credits($1)", [A]);
    const after = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.credit_ledger where user_id = $1 and reason = 'free_grant'",
      [A],
    );
    expect(after[0]!.n).toBe("1");
    const denied = await queryAs(
      { role: "authenticated", sub: A },
      "select public.grant_free_credits($1)",
      [A],
    );
    expect(denied.error?.message ?? "").toMatch(/permission denied/i);
  });

  it("debits one configured credit for a fresh imported cache and does not ask for a provider", async () => {
    const before = await balanceOf(A);
    const opened = await unlock(A, HOTEL.imported, "unlock-imported");
    expect(opened.error).toBeNull();
    expect(opened.rows[0]!.result.status).toBe("unlocked");
    expect(opened.rows[0]!.result.email).toBe(IMPORTED_EMAIL);
    expect(await unlockDeltas(A, HOTEL.imported)).toEqual([-CREDITS_CONFIG.unlockCost]);
    expect(await balanceOf(A)).toBe(before - CREDITS_CONFIG.unlockCost);
    const source = await adminQuery<{ source: string }>(
      "select source::text as source from public.contact_cache where hotel_id = $1",
      [HOTEL.imported],
    );
    expect(source[0]!.source).toBe("owner_import");
  });

  it("charges nothing to open the same hotel again, including the same idempotency key", async () => {
    const first = await unlock(A, HOTEL.fresh, "unlock-fresh");
    expect(first.rows[0]!.result.status).toBe("unlocked");
    const before = await balanceOf(A);
    const again = await unlock(A, HOTEL.fresh, "unlock-fresh-other");
    expect(again.rows[0]!.result).toMatchObject({
      status: "already_unlocked",
      email: "fresh@hotel.test",
    });
    const sameKey = await unlock(A, HOTEL.fresh, "unlock-fresh");
    expect(sameKey.rows[0]!.result.status).toBe("already_unlocked");
    expect(await unlockDeltas(A, HOTEL.fresh)).toEqual([-CREDITS_CONFIG.unlockCost]);
    expect(await balanceOf(A)).toBe(before);
  });

  it("spends one row when the same user repeats an idempotency key on another hotel", async () => {
    const first = await unlock(A, HOTEL.second, "shared-key");
    expect(first.rows[0]!.result.status).toBe("unlocked");
    expect(first.rows[0]!.result.email).toBe("second@hotel.test");
    const replay = await unlock(A, HOTEL.costly, "shared-key");
    expect(replay.rows[0]!.result).toMatchObject({ status: "idempotent_replay", email: null });
    const keys = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.credit_ledger where user_id = $1 and idempotency_key = 'shared-key'",
      [A],
    );
    expect(keys[0]!.n).toBe("1");
    expect(await unlockDeltas(A, HOTEL.costly)).toEqual([]);
  });

  it("returns no email and writes no row when the balance cannot cover the cost", async () => {
    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       select $1, -free_credits, 'reversal', 'drain-b'
         from public.credit_config`,
      [B],
    );
    expect(await balanceOf(B)).toBe(0);
    const opened = await unlock(B, HOTEL.fresh, "unlock-broke");
    expect(opened.rows[0]!.result).toMatchObject({
      status: "insufficient_credits",
      email: null,
      balance: 0,
    });
    expect(await unlockDeltas(B, HOTEL.fresh)).toEqual([]);
    const contacts = await queryAs(
      { role: "authenticated", sub: B },
      "select email from public.hotel_contacts where hotel_id = $1",
      [HOTEL.fresh],
    );
    expect(contacts.rows).toEqual([]);
  });

  it("does not charge a not-found cache while that policy is off", async () => {
    const before = await balanceOf(A);
    const opened = await unlock(A, HOTEL.missing, "unlock-missing");
    expect(opened.rows[0]!.result).toMatchObject({ status: "not_found", email: null });
    expect(await unlockDeltas(A, HOTEL.missing)).toEqual([]);
    expect(await balanceOf(A)).toBe(before);
  });

  it("debits the configured cost when the not-found policy is on, then restores it", async () => {
    const [prior] = await adminQuery<{ charge: boolean }>(
      "select charge_on_not_found as charge from public.credit_config",
    );
    await adminQuery("update public.credit_config set charge_on_not_found = true");
    try {
      const payer = "c05b0000-0000-4000-8000-0000000000aa";
      await makeUser(payer);
      const before = await balanceOf(payer);
      const opened = await unlock(payer, HOTEL.missing, "unlock-charge-miss");
      expect(opened.rows[0]!.result).toMatchObject({ status: "not_found", email: null });
      expect(await unlockDeltas(payer, HOTEL.missing)).toEqual([-CREDITS_CONFIG.unlockCost]);
      expect(await balanceOf(payer)).toBe(before - CREDITS_CONFIG.unlockCost);
    } finally {
      await adminQuery("update public.credit_config set charge_on_not_found = $1", [prior!.charge]);
    }
  });

  it("debits the live unlock cost, then restores the placeholder", async () => {
    const [prior] = await adminQuery<{ unlock_cost: number }>(
      "select unlock_cost from public.credit_config",
    );
    await adminQuery("update public.credit_config set unlock_cost = 2");
    try {
      const payer = "c05b0000-0000-4000-8000-0000000000bb";
      await makeUser(payer);
      const opened = await unlock(payer, HOTEL.costly, "unlock-cost-2");
      expect(opened.rows[0]!.result.status).toBe("unlocked");
      expect(await unlockDeltas(payer, HOTEL.costly)).toEqual([-2]);
    } finally {
      await adminQuery("update public.credit_config set unlock_cost = $1", [prior!.unlock_cost]);
    }
  });

  it("asks for a provider and does not debit when the cache is stale or absent", async () => {
    const before = await balanceOf(A);
    const stale = await unlock(A, HOTEL.stale, "unlock-stale");
    expect(stale.rows[0]!.result).toMatchObject({ status: "needs_provider", email: null });
    const absent = await unlock(A, HOTEL.empty, "unlock-empty");
    expect(absent.rows[0]!.result.status).toBe("needs_provider");
    expect(await balanceOf(A)).toBe(before);
  });

  it("commits exactly one debit when two unlocks race", async () => {
    const payer = "c05b0000-0000-4000-8000-0000000000cc";
    await makeUser(payer);
    const [left, right] = await Promise.all([
      commitAs<UnlockRow>(
        { role: "authenticated", sub: payer },
        "select public.unlock_hotel_contact($1, $2) as result",
        [HOTEL.race, "race-left"],
      ),
      commitAs<UnlockRow>(
        { role: "authenticated", sub: payer },
        "select public.unlock_hotel_contact($1, $2) as result",
        [HOTEL.race, "race-right"],
      ),
    ]);
    const statuses = [left, right]
      .filter((result) => result.error === null)
      .map((result) => result.rows[0]!.result.status);
    expect(statuses.filter((status) => status === "unlocked")).toHaveLength(1);
    expect(await unlockDeltas(payer, HOTEL.race)).toEqual([-CREDITS_CONFIG.unlockCost]);
    const owned = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.contact_unlocks where user_id = $1 and hotel_id = $2",
      [payer, HOTEL.race],
    );
    expect(owned[0]!.n).toBe("1");
  });

  it("hides user A's unlock, ledger, report, and contact from user B and from anon", async () => {
    const owned = await commitAs<UnlockRow>(
      { role: "authenticated", sub: A },
      "select public.unlock_hotel_contact($1, $2) as result",
      [HOTEL.report, "unlock-report-hotel"],
    );
    expect(owned.error).toBeNull();
    expect(owned.rows[0]!.result.email).toBe("report@hotel.test");

    const filed = await commitAs(
      { role: "authenticated", sub: A },
      `insert into public.contact_reports (user_id, hotel_id, reason)
       values ($1, $2, 'bounced') returning id`,
      [A, HOTEL.report],
    );
    expect(filed.error).toBeNull();

    for (const sql of [
      "select * from public.contact_unlocks where user_id = $1",
      "select * from public.credit_ledger where user_id = $1",
      "select * from public.contact_reports where user_id = $1",
      "select email from public.hotel_contacts where hotel_id = $2",
    ]) {
      const seen = await queryAs({ role: "authenticated", sub: B }, sql, [A, HOTEL.report]);
      expect(seen.rows, sql).toEqual([]);
      expect(JSON.stringify(seen), sql).not.toContain("report@hotel.test");
    }

    const cache = await queryAs(
      { role: "authenticated", sub: B },
      "select email, raw_provider_response from public.contact_cache where hotel_id = $1",
      [HOTEL.report],
    );
    expect(cache.error).not.toBeNull();
    const anonCache = await queryAs(
      { role: "anon", sub: null },
      "select email from public.contact_cache",
    );
    expect(anonCache.error).not.toBeNull();
    const anonContact = await queryAs(
      { role: "anon", sub: null },
      "select email from public.hotel_contacts where hotel_id = $1",
      [HOTEL.report],
    );
    expect(anonContact.error !== null || anonContact.rows.length === 0).toBe(true);
    expect(JSON.stringify(anonContact)).not.toContain("report@hotel.test");

    const balance = await queryAs(
      { role: "authenticated", sub: B },
      "select public.credit_balance($1)",
      [A],
    );
    expect(balance.error).not.toBeNull();
    const revealed = await queryAs<{ result: { email: string | null } }>(
      { role: "authenticated", sub: B },
      "select public.read_own_unlocked_contact($1) as result",
      [HOTEL.report],
    );
    expect(revealed.rows[0]!.result.email).toBeNull();
    expect(JSON.stringify(revealed)).not.toContain("raw");

    const own = await queryAs<{ result: { email: string | null } }>(
      { role: "authenticated", sub: A },
      "select public.read_own_unlocked_contact($1) as result",
      [HOTEL.report],
    );
    expect(own.rows[0]!.result.email).toBe("report@hotel.test");
    expect(JSON.stringify(own)).not.toContain("raw_provider");
  });

  it("refuses ledger updates and deletes for every role, including the table owner", async () => {
    const [row] = await adminQuery<{ id: string }>(
      "select id from public.credit_ledger where user_id = $1 limit 1",
      [A],
    );
    const ownerUpdate = await adminQuery(
      "update public.credit_ledger set delta = delta where id = $1",
      [row!.id],
    ).then(
      () => null,
      (error: { code?: string; message: string }) => error,
    );
    expect(ownerUpdate?.message ?? "").toMatch(/append-only/);
    const ownerDelete = await adminQuery("delete from public.credit_ledger where id = $1", [
      row!.id,
    ]).then(
      () => null,
      (error: { code?: string; message: string }) => error,
    );
    expect(ownerDelete?.message ?? "").toMatch(/append-only/);
    for (const role of ["authenticated", "service_role"] as const) {
      const updated = await queryAs(
        { role, sub: role === "authenticated" ? A : null },
        "update public.credit_ledger set ref_id = 'no' where id = $1",
        [row!.id],
      );
      expect(updated.error?.code, role).toBe("42501");
      const deleted = await queryAs(
        { role, sub: role === "authenticated" ? A : null },
        "delete from public.credit_ledger where id = $1",
        [row!.id],
      );
      expect(deleted.error?.code, role).toBe("42501");
    }
  });

  it("lets an admin grant once per key, and refuses an editor", async () => {
    const before = await balanceOf(B);
    const granted = await commitAs<{ result: { status: string; balance: number } }>(
      { role: "authenticated", sub: ADMIN },
      "select public.admin_grant_credits($1, 5, 'pilot-grant') as result",
      [B],
    );
    expect(granted.rows[0]!.result.status).toBe("granted");
    expect(await balanceOf(B)).toBe(before + 5);
    const repeat = await commitAs<{ result: { balance: number } }>(
      { role: "authenticated", sub: ADMIN },
      "select public.admin_grant_credits($1, 5, 'pilot-grant') as result",
      [B],
    );
    expect(repeat.rows[0]!.result.balance).toBe(before + 5);
    const editor = await queryAs(
      { role: "authenticated", sub: EDITOR },
      "select public.admin_grant_credits($1, 5, 'editor-grant')",
      [B],
    );
    expect(editor.error?.message ?? "").toMatch(/admin required/);
    await adminQuery(
      `insert into public.hotel_contacts (hotel_id, first_name, email, status, source_type)
       values ($1, 'Report', 'report@hotel.test', 'active', 'editorial')`,
      [HOTEL.report],
    );
    const staffContacts = await queryAs<{ email: string }>(
      { role: "authenticated", sub: EDITOR },
      "select email from public.hotel_contacts where hotel_id = $1",
      [HOTEL.report],
    );
    expect(staffContacts.error).toBeNull();
    expect(staffContacts.rows.map((row) => row.email)).toEqual(["report@hotel.test"]);
    const hidden = await queryAs(
      { role: "authenticated", sub: B },
      "select email from public.hotel_contacts where hotel_id = $1",
      [HOTEL.report],
    );
    expect(hidden.rows).toEqual([]);
  });

  it("accepts a report once: one courtesy credit and an invalid cache", async () => {
    const [report] = await adminQuery<{ id: string }>(
      "select id from public.contact_reports where user_id = $1 and hotel_id = $2",
      [A, HOTEL.report],
    );
    const before = await balanceOf(A);
    const accepted = await commitAs<{ result: { status: string } }>(
      { role: "authenticated", sub: ADMIN },
      "select public.review_contact_report($1, 'accept') as result",
      [report!.id],
    );
    expect(accepted.rows[0]!.result.status).toBe("accepted");
    expect(await balanceOf(A)).toBe(before + CREDITS_CONFIG.unlockCost);
    const again = await commitAs<{ result: { status: string } }>(
      { role: "authenticated", sub: ADMIN },
      "select public.review_contact_report($1, 'accept') as result",
      [report!.id],
    );
    expect(again.rows[0]!.result.status).toBe("accepted");
    expect(await balanceOf(A)).toBe(before + CREDITS_CONFIG.unlockCost);
    const cache = await adminQuery<{ status: string; reported: boolean }>(
      "select status::text as status, reported_invalid as reported from public.contact_cache where hotel_id = $1",
      [HOTEL.report],
    );
    expect(cache[0]).toEqual({ status: "invalid", reported: true });
    const stranger = await queryAs(
      { role: "authenticated", sub: B },
      "select public.review_contact_report($1, 'reject')",
      [report!.id],
    );
    expect(stranger.error?.message ?? "").toMatch(/admin required/);
  });
});
