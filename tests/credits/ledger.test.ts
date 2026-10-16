/**
 * F05 ledger, unlock, and isolation.
 *
 * A second connection must see a committed unlock, so the race and the
 * cross-user checks use commitAs. queryAs still rolls back. Changing
 * credit_config is restored before the test returns: this process is one
 * fork and setupDatabase runs once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FREE_LIMITS } from "@/lib/config";
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
  result: {
    status: string;
    email: string | null;
    balance?: number;
    pipeline_added?: boolean;
    limit?: number;
  };
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
    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       values ($1, 20, 'admin_grant', 'ledger-fixture')`,
      [A],
    );
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

  it("grants the current Free week once", async () => {
    const rows = await adminQuery<{ delta: number; idempotency_key: string }>(
      `select delta, idempotency_key
         from public.credit_ledger
        where user_id = $1 and reason = 'free_grant'`,
      [A],
    );
    expect(rows).toEqual([
      { delta: CREDITS_CONFIG.freeWeeklyCredits, idempotency_key: "free_weekly:0" },
    ]);
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
    expect(first.rows[0]!.result.pipeline_added).toBe(true);
    const before = await balanceOf(A);
    const again = await unlock(A, HOTEL.fresh, "unlock-fresh-other");
    expect(again.rows[0]!.result).toMatchObject({
      status: "already_unlocked",
      email: "fresh@hotel.test",
    });
    const sameKey = await unlock(A, HOTEL.fresh, "unlock-fresh");
    expect(sameKey.rows[0]!.result.status).toBe("already_unlocked");
    expect(sameKey.rows[0]!.result.pipeline_added).toBe(false);
    expect(await unlockDeltas(A, HOTEL.fresh)).toEqual([-CREDITS_CONFIG.unlockCost]);
    expect(await balanceOf(A)).toBe(before);
    const saved = await adminQuery<{ n: string; status: string; trip_id: string | null }>(
      `select count(*)::text as n, min(pi.status) as status, min(pi.trip_id::text) as trip_id
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1 and pi.hotel_id = $2`,
      [A, HOTEL.fresh],
    );
    expect(saved[0]).toEqual({ n: "1", status: "saved", trip_id: null });
  });

  it("spends one row when the same user repeats an idempotency key on another hotel", async () => {
    const first = await unlock(A, HOTEL.second, "shared-key");
    expect(first.rows[0]!.result.status).toBe("unlocked");
    expect(first.rows[0]!.result.email).toBe("second@hotel.test");
    const replay = await unlock(A, HOTEL.costly, "shared-key");
    expect(replay.rows[0]!.result).toMatchObject({
      status: "idempotent_replay",
      email: null,
      pipeline_added: false,
    });
    const replaySaved = await adminQuery<{ n: string }>(
      `select count(*)::text as n
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1 and pi.hotel_id = $2`,
      [A, HOTEL.costly],
    );
    expect(replaySaved[0]!.n).toBe("0");
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
       select $1, -bal.n, 'reversal', 'drain-b'
         from (
           select coalesce(sum(delta), 0)::int as n
             from public.credit_ledger
            where user_id = $1
         ) bal
        where bal.n <> 0`,
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
    const saved = await adminQuery<{ n: string }>(
      `select count(*)::text as n
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1 and pi.hotel_id = $2`,
      [B, HOTEL.fresh],
    );
    expect(saved[0]!.n).toBe("0");
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
    const saved = await adminQuery<{ n: string }>(
      `select count(*)::text as n
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1 and pi.hotel_id = $2`,
      [A, HOTEL.missing],
    );
    expect(saved[0]!.n).toBe("0");
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
      expect(opened.rows[0]!.result.pipeline_added).toBe(false);
      expect(await unlockDeltas(payer, HOTEL.missing)).toEqual([-CREDITS_CONFIG.unlockCost]);
      expect(await balanceOf(payer)).toBe(before - CREDITS_CONFIG.unlockCost);
      const saved = await adminQuery<{ n: string }>(
        `select count(*)::text as n
           from public.pipeline_items pi
           join public.creator_profiles cp on cp.id = pi.creator_id
          where cp.user_id = $1 and pi.hotel_id = $2`,
        [payer, HOTEL.missing],
      );
      expect(saved[0]!.n).toBe("0");
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

  it("serves a found email older than the TTL and does not let a re-check replace it", async () => {
    const before = await balanceOf(A);
    const stale = await unlock(A, HOTEL.stale, "unlock-stale");
    expect(stale.rows[0]!.result).toMatchObject({
      status: "unlocked",
      email: "stale@hotel.test",
    });
    expect(await unlockDeltas(A, HOTEL.stale)).toEqual([-CREDITS_CONFIG.unlockCost]);
    expect(await balanceOf(A)).toBe(before - CREDITS_CONFIG.unlockCost);
    await adminQuery(
      "select public.upsert_contact_cache($1, 'found-replaced@fake-provider.test', 'found', '{}'::jsonb)",
      [HOTEL.stale],
    );
    const kept = await adminQuery<{ email: string; source: string; status: string }>(
      `select email, source::text as source, status::text as status
         from public.contact_cache where hotel_id = $1`,
      [HOTEL.stale],
    );
    expect(kept[0]).toEqual({
      email: "stale@hotel.test",
      source: "provider",
      status: "found",
    });
    const again = await unlock(A, HOTEL.stale, "unlock-stale-again");
    expect(again.rows[0]!.result).toMatchObject({
      status: "already_unlocked",
      email: "stale@hotel.test",
    });
    expect(await unlockDeltas(A, HOTEL.stale)).toEqual([-CREDITS_CONFIG.unlockCost]);

    await adminQuery(
      "update public.contact_cache set last_verified_at = now() - interval '400 days' where hotel_id = $1",
      [HOTEL.missing],
    );
    const agedMiss = await unlock(A, HOTEL.missing, "unlock-aged-miss");
    expect(agedMiss.rows[0]!.result).toMatchObject({ status: "not_found", email: null });
    await adminQuery(
      "select public.upsert_contact_cache($1, 'found-aged@fake-provider.test', 'found', '{}'::jsonb)",
      [HOTEL.missing],
    );
    const miss = await adminQuery<{ email: string | null; status: string }>(
      "select email, status::text as status from public.contact_cache where hotel_id = $1",
      [HOTEL.missing],
    );
    expect(miss[0]).toEqual({ email: null, status: "not_found" });
  });

  it("returns insufficient credits before needs_provider when the balance cannot pay", async () => {
    const broke = "c05b0000-0000-4000-8000-0000000000d1";
    const hotel = "c05f0000-0000-4000-8000-0000000000d1";
    await makeUser(broke);
    await makeHotel(hotel, "No Cache Broke");
    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       select $1, -bal.n, 'reversal', 'drain-empty'
         from (
           select coalesce(sum(delta), 0)::int as n
             from public.credit_ledger
            where user_id = $1
         ) bal
        where bal.n <> 0`,
      [broke],
    );
    expect(await balanceOf(broke)).toBe(0);
    const opened = await unlock(broke, hotel, "unlock-broke-empty");
    expect(opened.rows[0]!.result).toMatchObject({
      status: "insufficient_credits",
      email: null,
      balance: 0,
    });
    expect(opened.rows[0]!.result.status).not.toBe("needs_provider");
    const cache = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.contact_cache where hotel_id = $1",
      [hotel],
    );
    expect(cache[0]!.n).toBe("0");
  });

  it("asks for a provider and does not debit when the cache row is absent", async () => {
    const before = await balanceOf(A);
    const absent = await unlock(A, HOTEL.empty, "unlock-empty");
    expect(absent.rows[0]!.result.status).toBe("needs_provider");
    expect(await balanceOf(A)).toBe(before);
    const saved = await adminQuery<{ n: string }>(
      `select count(*)::text as n
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1 and pi.hotel_id = $2`,
      [A, HOTEL.empty],
    );
    expect(saved[0]!.n).toBe("0");
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
    const rows = await adminQuery<{ n: string }>(
      `select count(*)::text as n
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1 and pi.hotel_id = $2 and pi.status <> 'closed'`,
      [payer, HOTEL.race],
    );
    expect(rows[0]!.n).toBe("1");
    const added = [left, right]
      .filter((result) => result.error === null)
      .filter((result) => result.rows[0]!.result.pipeline_added === true);
    expect(added).toHaveLength(1);
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
    const stored = await adminQuery<{ email: string; bounces: number }>(
      "select email, bounce_count as bounces from public.contact_cache where hotel_id = $1",
      [HOTEL.report],
    );
    expect(stored[0]).toEqual({ email: "report@hotel.test", bounces: 1 });
    await adminQuery(
      "select public.upsert_contact_cache($1, 'found-bounce@fake-provider.test', 'found', '{}'::jsonb)",
      [HOTEL.report],
    );
    const stillInvalid = await adminQuery<{
      email: string;
      status: string;
      reported: boolean;
    }>(
      `select email, status::text as status, reported_invalid as reported
         from public.contact_cache where hotel_id = $1`,
      [HOTEL.report],
    );
    expect(stillInvalid[0]).toEqual({
      email: "report@hotel.test",
      status: "invalid",
      reported: true,
    });

    const ownerRows = await queryAs<{ email: string | null }>(
      { role: "authenticated", sub: A },
      "select email from public.hotel_contacts where hotel_id = $1",
      [HOTEL.report],
    );
    expect(ownerRows.error).toBeNull();
    expect(JSON.stringify(ownerRows)).not.toContain("report@hotel.test");
    expect(ownerRows.rows.every((row) => row.email == null)).toBe(true);
    const staffRows = await queryAs<{ email: string | null }>(
      { role: "authenticated", sub: EDITOR },
      "select email from public.hotel_contacts where hotel_id = $1",
      [HOTEL.report],
    );
    expect(JSON.stringify(staffRows)).not.toContain("report@hotel.test");

    const reread = await queryAs<{ result: { email: string | null } }>(
      { role: "authenticated", sub: A },
      "select public.read_own_unlocked_contact($1) as result",
      [HOTEL.report],
    );
    expect(reread.rows[0]!.result.email).toBeNull();
    const balanceAfter = await balanceOf(A);
    const reopened = await unlock(A, HOTEL.report, "unlock-report-after-bounce");
    expect(reopened.rows[0]!.result).toMatchObject({
      status: "already_unlocked",
      email: null,
    });
    expect(await balanceOf(A)).toBe(balanceAfter);
    expect(await unlockDeltas(A, HOTEL.report)).toEqual([-CREDITS_CONFIG.unlockCost]);

    const strangerUnlock = await unlock(B, HOTEL.report, "unlock-invalid-stranger");
    expect(strangerUnlock.rows[0]!.result).toMatchObject({ status: "not_found", email: null });
    expect(await unlockDeltas(B, HOTEL.report)).toEqual([]);
    expect(JSON.stringify(strangerUnlock)).not.toContain("report@hotel.test");

    const stranger = await queryAs(
      { role: "authenticated", sub: B },
      "select public.review_contact_report($1, 'reject')",
      [report!.id],
    );
    expect(stranger.error?.message ?? "").toMatch(/admin required/);
  });

  it("keeps a contact visible for a user who could already see it, without spending the Free grant", async () => {
    const pass = "c05a0000-0000-4000-8000-0000000000d1";
    const pro = "c05a0000-0000-4000-8000-0000000000d2";
    const free = "c05a0000-0000-4000-8000-0000000000d3";
    const expired = "c05a0000-0000-4000-8000-0000000000d4";
    const ibizaDest = "c05d0000-0000-4000-8000-0000000000a9";
    const bali = "c05f0000-0000-4000-8000-0000000000a1";
    const ibiza = "c05f0000-0000-4000-8000-0000000000a2";
    const phoneOnly = "c05f0000-0000-4000-8000-0000000000a3";

    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Credit Ibiza', 'credit-ibiza', 'city')",
      [ibizaDest],
    );
    await makeUser(pass);
    await makeUser(pro);
    await makeUser(free);
    await makeUser(expired);
    await makeHotel(bali, "Grandfather Bali");
    await makeHotel(phoneOnly, "Grandfather Phone");
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, 'Grandfather Ibiza', 'c05-grandfather-ibiza', $2)",
      [ibiza, ibizaDest],
    );
    await adminQuery(
      `insert into public.hotel_contacts (hotel_id, first_name, email, status, source_type)
       values ($1, 'Bali', 'bali-kept@hotel.test', 'active', 'editorial'),
              ($2, 'Ibiza', 'ibiza-kept@hotel.test', 'active', 'editorial')`,
      [bali, ibiza],
    );
    await adminQuery(
      `insert into public.hotel_contacts (hotel_id, first_name, phone, status, source_type)
       values ($1, 'Phone', '+15550001111', 'active', 'editorial')`,
      [phoneOnly],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at, source, source_reference)
       values
         ($1, 'destination', $2, 'active', now(), 'test', 'gf-pass'),
         ($3, 'pro', null, 'active', now(), 'test', 'gf-pro'),
         ($4, 'destination', $2, 'expired', now() - interval '30 days', 'test', 'gf-expired')`,
      [pass, DEST, pro, expired],
    );

    const editorBefore = await balanceOf(EDITOR);
    const inserted = await adminQuery<{ n: number }>(
      "select public.grandfather_visible_contact_unlocks() as n",
    );
    expect(inserted[0]!.n).toBeGreaterThan(0);
    expect(await balanceOf(pass)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    expect(await balanceOf(pro)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    expect(await balanceOf(free)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    expect(await balanceOf(expired)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    expect(await balanceOf(EDITOR)).toBe(editorBefore);

    const passRows = await queryAs<{
      hotel_id: string;
      email: string | null;
      phone: string | null;
    }>(
      { role: "authenticated", sub: pass },
      "select hotel_id, email, phone from public.hotel_contacts where hotel_id = any($1::uuid[])",
      [[bali, ibiza, phoneOnly]],
    );
    expect(passRows.error).toBeNull();
    expect(
      passRows.rows
        .map((row) => row.email)
        .filter(Boolean)
        .sort(),
    ).toEqual(["bali-kept@hotel.test"]);
    expect(passRows.rows.some((row) => row.phone === "+15550001111")).toBe(true);
    expect(JSON.stringify(passRows)).not.toContain("ibiza-kept@hotel.test");

    const proRows = await queryAs<{ email: string | null }>(
      { role: "authenticated", sub: pro },
      "select email from public.hotel_contacts where hotel_id = any($1::uuid[])",
      [[bali, ibiza]],
    );
    expect(proRows.rows.map((row) => row.email).sort()).toEqual([
      "bali-kept@hotel.test",
      "ibiza-kept@hotel.test",
    ]);

    for (const userId of [free, expired]) {
      const hidden = await queryAs(
        { role: "authenticated", sub: userId },
        "select email, phone from public.hotel_contacts where hotel_id = any($1::uuid[])",
        [[bali, ibiza, phoneOnly]],
      );
      expect(hidden.rows).toEqual([]);
      const owned = await adminQuery<{ n: string }>(
        "select count(*)::text as n from public.contact_unlocks where user_id = $1",
        [userId],
      );
      expect(owned[0]!.n).toBe("0");
    }

    const passNet = await adminQuery<{ n: number }>(
      `select coalesce(sum(delta), 0)::int as n
         from public.credit_ledger
        where user_id = $1 and idempotency_key like 'grandfather%'`,
      [pass],
    );
    expect(passNet[0]!.n).toBe(0);
    const passUnlocks = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.contact_unlocks where user_id = $1",
      [pass],
    );
    expect(Number(passUnlocks[0]!.n)).toBeGreaterThanOrEqual(2);
    const staffKept = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.contact_unlocks where user_id = $1 and hotel_id = $2",
      [EDITOR, bali],
    );
    expect(staffKept[0]!.n).toBe("1");
    const untouched = await adminQuery<{ n: string }>(
      `select count(*)::text as n from public.credit_ledger
        where user_id = $1 and idempotency_key like 'grandfather%'`,
      [A],
    );
    expect(untouched[0]!.n).toBe("0");

    const ledgerRows = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.credit_ledger where user_id = $1",
      [pass],
    );
    const second = await adminQuery<{ n: number }>(
      "select public.grandfather_visible_contact_unlocks() as n",
    );
    expect(second[0]!.n).toBe(0);
    const ledgerAfter = await adminQuery<{ n: string }>(
      "select count(*)::text as n from public.credit_ledger where user_id = $1",
      [pass],
    );
    expect(ledgerAfter[0]!.n).toBe(ledgerRows[0]!.n);
    expect(await balanceOf(pass)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
  });

  it("saves a revealed contact once, refuses a full pipeline, and hides the other creator", async () => {
    const cap = "c05b0000-0000-4000-8000-0000000000e1";
    const room = "c05b0000-0000-4000-8000-0000000000e2";
    const pro = "c05b0000-0000-4000-8000-0000000000e3";
    const pitchedUser = "c05b0000-0000-4000-8000-0000000000e4";
    const closedUser = "c05b0000-0000-4000-8000-0000000000e5";
    const reopenUser = "c05b0000-0000-4000-8000-0000000000e6";
    const fillers = Array.from(
      { length: FREE_LIMITS.savedHotels },
      (_, i) => `c05f1000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
    );
    const target = "c05f1000-0000-4000-8000-0000000000aa";
    const pitchedHotel = "c05f1000-0000-4000-8000-0000000000bb";
    const closedHotel = "c05f1000-0000-4000-8000-0000000000cc";
    const reopenHotel = "c05f1000-0000-4000-8000-0000000000dd";

    async function creatorId(userId: string): Promise<string> {
      const [row] = await adminQuery<{ id: string }>(
        "select id from public.creator_profiles where user_id = $1",
        [userId],
      );
      return row!.id;
    }

    async function openCount(userId: string): Promise<number> {
      const [row] = await adminQuery<{ n: string }>(
        `select count(*)::text as n
           from public.pipeline_items pi
           join public.creator_profiles cp on cp.id = pi.creator_id
          where cp.user_id = $1 and pi.status <> 'closed'`,
        [userId],
      );
      return Number(row!.n);
    }

    for (const id of [cap, room, pro, pitchedUser, closedUser, reopenUser]) await makeUser(id);
    for (const [index, id] of fillers.entries()) await makeHotel(id, `Cap filler ${index}`);
    await makeHotel(target, "Pipeline target");
    await makeHotel(pitchedHotel, "Already pitched");
    await makeHotel(closedHotel, "Closed cycle");
    await makeHotel(reopenHotel, "Closed then unlock");
    await cacheFound(target, "target@hotel.test");
    await cacheFound(pitchedHotel, "pitched@hotel.test");
    await cacheFound(closedHotel, "closed@hotel.test");
    await cacheFound(reopenHotel, "reopen@hotel.test");

    for (const userId of [cap, pro]) {
      const creator = await creatorId(userId);
      for (const hotelId of fillers) {
        await adminQuery(
          `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
           values ($1, $2, 'saved', 1)`,
          [creator, hotelId],
        );
      }
    }
    const roomCreator = await creatorId(room);
    for (const hotelId of fillers.slice(0, FREE_LIMITS.savedHotels - 1)) {
      await adminQuery(
        `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
         values ($1, $2, 'saved', 1)`,
        [roomCreator, hotelId],
      );
    }

    const capBefore = await balanceOf(cap);
    const blocked = await unlock(cap, target, "unlock-cap");
    expect(blocked.rows[0]!.result).toMatchObject({
      status: "pipeline_limit",
      email: null,
      pipeline_added: false,
      limit: FREE_LIMITS.savedHotels,
    });
    expect(JSON.stringify(blocked.rows[0]!.result)).not.toContain("target@hotel.test");
    const blockedMiss = await unlock(cap, HOTEL.missing, "unlock-cap-miss");
    expect(blockedMiss.rows[0]!.result.status).toBe("pipeline_limit");
    expect(blocked.rows[0]!.result.status).toBe(blockedMiss.rows[0]!.result.status);
    expect(await balanceOf(cap)).toBe(capBefore);
    expect(await unlockDeltas(cap, target)).toEqual([]);
    expect(await openCount(cap)).toBe(FREE_LIMITS.savedHotels);

    const tripsBefore = await adminQuery<{ n: string }>(
      `select count(*)::text as n
         from public.trips t
         join public.creator_profiles cp on cp.id = t.creator_id
        where cp.user_id = $1`,
      [room],
    );
    const opened = await unlock(room, target, "unlock-room");
    expect(opened.rows[0]!.result).toMatchObject({
      status: "unlocked",
      email: "target@hotel.test",
      pipeline_added: true,
    });
    expect(await openCount(room)).toBe(FREE_LIMITS.savedHotels);
    const roomRow = await adminQuery<{ status: string; trip_id: string | null; events: string }>(
      `select pi.status, pi.trip_id::text as trip_id, count(oe.id)::text as events
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
         left join public.outreach_events oe
           on oe.pipeline_item_id = pi.id and oe.event_type = 'hotel_saved'
        where cp.user_id = $1 and pi.hotel_id = $2
        group by pi.status, pi.trip_id`,
      [room, target],
    );
    expect(roomRow).toEqual([{ status: "saved", trip_id: null, events: "1" }]);
    const tripsAfter = await adminQuery<{ n: string }>(
      `select count(*)::text as n
         from public.trips t
         join public.creator_profiles cp on cp.id = t.creator_id
        where cp.user_id = $1`,
      [room],
    );
    expect(tripsAfter[0]!.n).toBe(tripsBefore[0]!.n);
    const again = await unlock(room, target, "unlock-room-again");
    expect(again.rows[0]!.result).toMatchObject({
      status: "already_unlocked",
      email: "target@hotel.test",
      pipeline_added: false,
    });
    expect(await openCount(room)).toBe(FREE_LIMITS.savedHotels);
    expect(await unlockDeltas(room, target)).toEqual([-CREDITS_CONFIG.unlockCost]);

    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values ($1, 'pro', 'active', now(), 'test', 'f05b-pro')`,
      [pro],
    );
    const proOpen = await unlock(pro, target, "unlock-pro");
    expect(proOpen.rows[0]!.result.status).toBe("unlocked");
    expect(proOpen.rows[0]!.result.pipeline_added).toBe(true);
    expect(await openCount(pro)).toBe(FREE_LIMITS.savedHotels + 1);

    const pitchedCreator = await creatorId(pitchedUser);
    await adminQuery(
      `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
       values ($1, $2, 'pitched', 1)`,
      [pitchedCreator, pitchedHotel],
    );
    const kept = await unlock(pitchedUser, pitchedHotel, "unlock-pitched");
    expect(kept.rows[0]!.result).toMatchObject({
      status: "unlocked",
      email: "pitched@hotel.test",
      pipeline_added: false,
    });
    const pitchedRows = await adminQuery<{ status: string; n: string }>(
      `select pi.status, count(*)::text as n
         from public.pipeline_items pi
        where pi.creator_id = $1 and pi.hotel_id = $2
        group by pi.status`,
      [pitchedCreator, pitchedHotel],
    );
    expect(pitchedRows).toEqual([{ status: "pitched", n: "1" }]);

    const closedOpen = await unlock(closedUser, closedHotel, "unlock-closed-first");
    expect(closedOpen.rows[0]!.result.pipeline_added).toBe(true);
    await adminQuery(
      `update public.pipeline_items pi
          set status = 'closed'
         from public.creator_profiles cp
        where pi.creator_id = cp.id and cp.user_id = $1 and pi.hotel_id = $2`,
      [closedUser, closedHotel],
    );
    const closedAgain = await unlock(closedUser, closedHotel, "unlock-closed-again");
    expect(closedAgain.rows[0]!.result).toMatchObject({
      status: "already_unlocked",
      pipeline_added: false,
    });
    const closedRows = await adminQuery<{ n: string; status: string }>(
      `select count(*)::text as n, min(pi.status) as status
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1 and pi.hotel_id = $2`,
      [closedUser, closedHotel],
    );
    expect(closedRows[0]).toEqual({ n: "1", status: "closed" });

    const reopenCreator = await creatorId(reopenUser);
    await adminQuery(
      `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
       values ($1, $2, 'closed', 1)`,
      [reopenCreator, reopenHotel],
    );
    const reopened = await unlock(reopenUser, reopenHotel, "unlock-reopen");
    expect(reopened.rows[0]!.result).toMatchObject({
      status: "unlocked",
      pipeline_added: true,
    });
    const cycles = await adminQuery<{ status: string }>(
      `select status from public.pipeline_items
        where creator_id = $1 and hotel_id = $2
        order by cycle_number`,
      [reopenCreator, reopenHotel],
    );
    expect(cycles.map((row) => row.status)).toEqual(["closed", "saved"]);

    const hidden = await queryAs<{ hotel_id: string }>(
      { role: "authenticated", sub: B },
      "select hotel_id from public.pipeline_items",
    );
    expect(hidden.rows.map((row) => row.hotel_id)).not.toContain(target);
    const stranger = await queryAs<{ result: unknown }>(
      { role: "authenticated", sub: B },
      "select public.read_own_unlocked_contacts($1::uuid[]) as result",
      [[target, pitchedHotel]],
    );
    expect(JSON.stringify(stranger)).not.toContain("target@hotel.test");
    expect(JSON.stringify(stranger)).not.toContain("pitched@hotel.test");
    const own = await queryAs<{ result: { hotel_id: string; email: string }[] }>(
      { role: "authenticated", sub: room },
      "select public.read_own_unlocked_contacts($1::uuid[]) as result",
      [[target, pitchedHotel]],
    );
    expect(own.rows[0]!.result).toEqual([{ hotel_id: target, email: "target@hotel.test" }]);
    const anon = await queryAs(
      { role: "anon", sub: null },
      "select public.read_own_unlocked_contacts($1::uuid[])",
      [[target]],
    );
    expect(anon.error?.message ?? "").toMatch(/permission denied/i);
  });
});
