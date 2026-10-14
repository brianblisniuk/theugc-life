/**
 * P01 grants (D131–D134).
 *
 * Weekly Free credits do not stack. A legacy free_grant:v1 is not reduced.
 * Pro and Max monthly grants are idempotent. User A's Max does not change
 * User B. A subscription row is not an entitlement and not a credit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FREE_LIMITS } from "@/lib/config";
import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";
import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const DEST = "d1310000-0000-4000-8000-000000000001";
const FREE = "d131a000-0000-4000-8000-000000000001";
const OTHER = "d131b000-0000-4000-8000-000000000002";
const PRO = "d131c000-0000-4000-8000-000000000003";
const MAX = "d131d000-0000-4000-8000-000000000004";
const BOTH = "d131e000-0000-4000-8000-000000000005";
const LEGACY = "d131f000-0000-4000-8000-000000000006";

async function balanceOf(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    "select coalesce(sum(delta), 0)::int as n from public.credit_ledger where user_id = $1",
    [userId],
  );
  return rows[0]!.n;
}

async function makeAuthUser(id: string) {
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@plans.test`]);
}

d("plan grants", () => {
  beforeAll(async () => {
    await setupDatabase();
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Plan Bay', 'plan-bay', 'city')",
      [DEST],
    );
    await makeAuthUser(FREE);
    await makeAuthUser(OTHER);
    await makeAuthUser(PRO);
    await makeAuthUser(MAX);
    await makeAuthUser(BOTH);
    await adminQuery("insert into public.users (id, email, role) values ($1, $2, 'creator')", [
      LEGACY,
      "legacy@plans.test",
    ]);
    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       values ($1, $2, 'free_grant', 'free_grant:v1')`,
      [LEGACY, CREDITS_CONFIG.legacyFreeGrant],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("does not stack unused weekly credits and does not spend the legacy grant", async () => {
    expect(await balanceOf(FREE)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    await adminQuery("select public.ensure_credit_grants($1)", [FREE]);
    expect(await balanceOf(FREE)).toBe(CREDITS_CONFIG.freeWeeklyCredits);

    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       values ($1, -2, 'reversal', 'spend-two')`,
      [FREE],
    );
    expect(await balanceOf(FREE)).toBe(CREDITS_CONFIG.freeWeeklyCredits - 2);

    await adminQuery(
      "update public.users set created_at = now() - interval '8 days' where id = $1",
      [FREE],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [FREE]);
    expect(await balanceOf(FREE)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    await adminQuery("select public.ensure_credit_grants($1)", [FREE]);
    expect(await balanceOf(FREE)).toBe(CREDITS_CONFIG.freeWeeklyCredits);

    const legacyBefore = await balanceOf(LEGACY);
    expect(legacyBefore).toBe(CREDITS_CONFIG.legacyFreeGrant);
    await adminQuery("select public.ensure_credit_grants($1)", [LEGACY]);
    expect(await balanceOf(LEGACY)).toBe(
      CREDITS_CONFIG.legacyFreeGrant + CREDITS_CONFIG.freeWeeklyCredits,
    );
    await adminQuery(
      "update public.users set created_at = now() - interval '8 days' where id = $1",
      [LEGACY],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [LEGACY]);
    expect(await balanceOf(LEGACY)).toBe(
      CREDITS_CONFIG.legacyFreeGrant + CREDITS_CONFIG.freeWeeklyCredits,
    );
    const legacy = await adminQuery<{ n: number }>(
      `select coalesce(sum(delta), 0)::int as n
         from public.credit_ledger
        where user_id = $1 and idempotency_key = 'free_grant:v1'`,
      [LEGACY],
    );
    expect(legacy[0]!.n).toBe(CREDITS_CONFIG.legacyFreeGrant);
    expect(await balanceOf(OTHER)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
  });

  it("refuses a client grant for another user", async () => {
    const denied = await queryAs(
      { role: "authenticated", sub: FREE },
      "select public.ensure_credit_grants($1)",
      [OTHER],
    );
    expect(denied.error?.message ?? "").toMatch(/permission denied/i);
    const own = await queryAs<{ n: number }>(
      { role: "authenticated", sub: OTHER },
      "select public.ensure_own_credit_grants() as n",
    );
    expect(own.error).toBeNull();
    expect(own.rows[0]!.n).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    expect(await balanceOf(FREE)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
  });

  it("grants Pro monthly once, and Max instead of both when both rows are active", async () => {
    const proBefore = await balanceOf(PRO);
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values ($1, 'pro', 'active', now(), 'test', 'p01-pro')`,
      [PRO],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [PRO]);
    expect(await balanceOf(PRO)).toBe(proBefore + CREDITS_CONFIG.planMonthlyCredits.pro);
    await adminQuery("select public.ensure_credit_grants($1)", [PRO]);
    expect(await balanceOf(PRO)).toBe(proBefore + CREDITS_CONFIG.planMonthlyCredits.pro);

    const bothBefore = await balanceOf(BOTH);
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values
         ($1, 'pro', 'active', now() - interval '1 day', 'test', 'p01-both-pro'),
         ($1, 'max', 'active', now(), 'test', 'p01-both-max')`,
      [BOTH],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [BOTH]);
    expect(await balanceOf(BOTH)).toBe(bothBefore + CREDITS_CONFIG.planMonthlyCredits.max);
    const proGrants = await adminQuery<{ n: string }>(
      `select count(*)::text as n from public.credit_ledger
        where user_id = $1 and reason = 'plan_grant' and idempotency_key like 'plan_monthly:pro:%'`,
      [BOTH],
    );
    expect(proGrants[0]!.n).toBe("0");
  });

  it("does not let a subscription or Max row for A unlock B", async () => {
    await adminQuery(
      `insert into public.subscriptions
         (user_id, provider, provider_subscription_id, plan_code, status, price_paid, currency)
       values ($1, 'stub', 'p01-sub', 'max', 'active', $2, 'USD')`,
      [OTHER, PLAN_PRICES.max.monthlyUsd],
    );
    await adminQuery(
      `insert into public.purchases
         (user_id, provider, provider_transaction_id, product_type, amount, currency, status)
       values ($1, 'stub', 'p01-pack', 'credit_pack', 40, 'USD', 'paid')`,
      [OTHER],
    );
    const before = await balanceOf(OTHER);
    await adminQuery("select public.ensure_credit_grants($1)", [OTHER]);
    expect(await balanceOf(OTHER)).toBe(before);

    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values ($1, 'max', 'active', now(), 'test', 'p01-max')`,
      [MAX],
    );
    const flags = await queryAs<{ features: { tier: string; priority_ai: boolean } }>(
      { role: "authenticated", sub: MAX },
      "select public.own_plan_features() as features",
    );
    expect(flags.rows[0]?.features.tier).toBe("max");
    expect(flags.rows[0]?.features.priority_ai).toBe(true);
    const otherFlags = await queryAs<{ features: { tier: string; priority_ai: boolean } }>(
      { role: "authenticated", sub: OTHER },
      "select public.own_plan_features() as features",
    );
    expect(otherFlags.rows[0]?.features.tier).toBe("free");
    expect(otherFlags.rows[0]?.features.priority_ai).toBe(false);

    const maxPremium = await queryAs<{ v: boolean }>(
      { role: "authenticated", sub: MAX },
      "select public.has_active_max() as v",
    );
    expect(maxPremium.rows[0]?.v).toBe(true);
    const otherMax = await queryAs<{ v: boolean }>(
      { role: "authenticated", sub: OTHER },
      "select public.has_active_max() as v",
    );
    expect(otherMax.rows[0]?.v).toBe(false);

    const priced = await adminQuery<{ pro_monthly: number; max_monthly: number }>(
      `select pro_price_monthly_usd as pro_monthly, max_price_monthly_usd as max_monthly
         from public.credit_config`,
    );
    expect(priced[0]).toEqual({
      pro_monthly: PLAN_PRICES.pro.monthlyUsd,
      max_monthly: PLAN_PRICES.max.monthlyUsd,
    });
    const blocked = await queryAs(
      { role: "authenticated", sub: FREE },
      "update public.credit_config set pro_price_monthly_usd = 1",
    );
    expect(blocked.error).not.toBeNull();
  });

  it("lets Max pass the Free saved-hotel cap and still caps the other creator", async () => {
    const hotels: string[] = [];
    for (let i = 0; i < FREE_LIMITS.savedHotels + 1; i += 1) {
      const id = `d1311000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      hotels.push(id);
      await adminQuery(
        "insert into public.hotels (id, name, slug, destination_id) values ($1, $2, $3, $4)",
        [id, `Plan hotel ${i}`, `plan-hotel-${i}`, DEST],
      );
    }
    const freeCreator = await adminQuery<{ id: string }>(
      "select id from public.creator_profiles where user_id = $1",
      [OTHER],
    );
    for (const hotelId of hotels.slice(0, FREE_LIMITS.savedHotels)) {
      await adminQuery(
        `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
         values ($1, $2, 'saved', 1)`,
        [freeCreator[0]!.id, hotelId],
      );
    }
    const blocked = await adminQuery<{ result: string }>(
      "select public.save_hotel_to_pipeline($1, $2, $3)->>'result' as result",
      [OTHER, hotels[FREE_LIMITS.savedHotels], FREE_LIMITS.savedHotels],
    );
    expect(blocked[0]!.result).toBe("limit_reached");

    const opened = await adminQuery<{ result: string }>(
      "select public.save_hotel_to_pipeline($1, $2, $3)->>'result' as result",
      [MAX, hotels[FREE_LIMITS.savedHotels], FREE_LIMITS.savedHotels],
    );
    expect(opened[0]!.result).toBe("created");
  });
});
