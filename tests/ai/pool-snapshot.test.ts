/**
 * D188. ai_pool_snapshot uses the same 15–20% clamp and uncapped floor as
 * poolPercentBps / readBudgetMicros. A $100 previous-month purchase is
 * refunded before the file ends so later pool reads stay unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER = "d188c000-0000-4000-8000-0000000000c6";
const PAYMENT = "pay_poolsnap100";

interface Snapshot {
  got1000: string;
  at15: string;
  at10: string;
  got5000: string;
  at20: string;
  at50: string;
  gotFloor: string;
  portion20: string;
  gotNull: string;
  gotZero: string;
  gotNegative: string;
}

async function snapshot(): Promise<Snapshot> {
  const rows = await adminQuery<Snapshot>(
    `with bounds as (
       select (date_trunc('month', now() at time zone 'utc') at time zone 'utc') as month_start
     ),
     rev as (
       select coalesce(sum(p.amount), 0) as dollars
         from public.purchases p, bounds b
        where p.status = 'approved'
          and p.refunded_at is null
          and upper(coalesce(p.currency, '')) = 'USD'
          and p.purchased_at >= b.month_start - interval '1 month'
          and p.purchased_at < b.month_start
     )
     select
       (select pool_micros::text from public.ai_pool_snapshot(0, 1000)) as "got1000",
       greatest(0, round(rev.dollars * 1500 * 100))::bigint::text as at15,
       greatest(0, round(rev.dollars * 1000 * 100))::bigint::text as at10,
       (select pool_micros::text from public.ai_pool_snapshot(0, 5000)) as "got5000",
       greatest(0, round(rev.dollars * 2000 * 100))::bigint::text as at20,
       greatest(0, round(rev.dollars * 5000 * 100))::bigint::text as at50,
       (select pool_micros::text from public.ai_pool_snapshot(150000000000, 2000)) as "gotFloor",
       greatest(0, round(rev.dollars * 2000 * 100))::bigint::text as portion20,
       (select pool_micros::text from public.ai_pool_snapshot(null, null)) as "gotNull",
       (select pool_micros::text from public.ai_pool_snapshot(0, 1500)) as "gotZero",
       (select pool_micros::text from public.ai_pool_snapshot(-5, 1500)) as "gotNegative"
     from rev`,
  );
  return rows[0]!;
}

d("ai pool snapshot clamp", () => {
  beforeAll(async () => {
    await setupDatabase();
    await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
      USER,
      "pool-snapshot@example.invalid",
    ]);
    await adminQuery(
      `insert into public.purchases
         (user_id, provider, provider_transaction_id, product_type, amount, currency, status, purchased_at)
       values (
         $1, 'rebill', $2, 'plan', 100, 'USD', 'approved',
         (date_trunc('month', now() at time zone 'utc') at time zone 'utc') - interval '1 day'
       )`,
      [USER, PAYMENT],
    );
  }, 120_000);

  afterAll(async () => {
    await adminQuery(
      `update public.purchases
          set refunded_at = now(), status = 'refunded'
        where provider_transaction_id = $1`,
      [PAYMENT],
    );
    await teardownDatabase();
  });

  it("clamps 10% to 15%, 50% to 20%, and keeps a floor above $100,000", async () => {
    const row = await snapshot();
    expect(BigInt(row.got1000)).toBe(BigInt(row.at15));
    expect(BigInt(row.got1000)).not.toBe(BigInt(row.at10));
    expect(BigInt(row.got5000)).toBe(BigInt(row.at20));
    expect(BigInt(row.got5000)).toBeLessThan(BigInt(row.at50));
    const portion = BigInt(row.portion20);
    const floor = 150_000_000_000n;
    expect(BigInt(row.gotFloor)).toBe(portion > floor ? portion : floor);
    expect(BigInt(row.gotFloor)).toBeGreaterThan(100_000_000_000n);
    expect(row.gotNull).toBe(row.gotZero);
    expect(row.gotNegative).toBe(row.gotZero);
  });
});
