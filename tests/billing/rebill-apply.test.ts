/**
 * P02 Rebill effects (D135–D139).
 *
 * A purchase or a subscription is not access. apply_rebill_event is the
 * service-role writer. The account comes from the checkout or the stored
 * subscription, never from a payload user id. A second delivery of the same
 * payment does not extend twice. A failed payment does not extend. An annual
 * payment grants the next 30-day bucket without another payment. A monthly
 * refund removes that payment's slice. An annual refund ends the plan. A
 * pack refund reverses unused credits only. A chargeback still ends the
 * subscription (D140).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";
import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const A = "d135a000-0000-4000-8000-000000000001";
const B = "d135b000-0000-4000-8000-000000000002";
const ANNUAL = "d135c000-0000-4000-8000-000000000003";
const PACK = "d135d000-0000-4000-8000-000000000004";
const REFUND = "d135e000-0000-4000-8000-000000000005";
const UPGRADE = "d135f000-0000-4000-8000-000000000006";
const DOWN = "d135aa00-0000-4000-8000-000000000007";
const LAPSE = "d135ab00-0000-4000-8000-000000000008";
const SLICE = "d140a000-0000-4000-8000-000000000001";
const GAP = "d140b000-0000-4000-8000-000000000002";
const YEAR = "d140c000-0000-4000-8000-000000000003";
const PACKCB = "d140d000-0000-4000-8000-000000000004";
const WEEKLY = "d140e000-0000-4000-8000-000000000005";
const LEAK = "d141a000-0000-4000-8000-000000000001";
const LEAKCB = "d141b000-0000-4000-8000-000000000002";
const PACKS = "d141c000-0000-4000-8000-000000000003";
const WEEKEX = "d141d000-0000-4000-8000-000000000004";
const AFTER = "d141e000-0000-4000-8000-000000000005";
const KEEP = "d141f000-0000-4000-8000-000000000006";
const RENEW = "d141aa00-0000-4000-8000-000000000007";
const MID = "d141ab00-0000-4000-8000-000000000008";
const LEGACY = "d141ac00-0000-4000-8000-000000000009";
const STAY = "d141ad00-0000-4000-8000-00000000000a";
const PASTDUE = "d188b000-0000-4000-8000-000000000002";

async function makeUser(id: string) {
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@rebill.test`]);
}

async function balanceOf(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    "select coalesce(sum(delta), 0)::int as n from public.credit_ledger where user_id = $1",
    [userId],
  );
  return rows[0]!.n;
}

async function planGrants(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    `select count(*)::int as n from public.credit_ledger
      where user_id = $1 and reason = 'plan_grant'`,
    [userId],
  );
  return rows[0]!.n;
}

async function apply(event: Record<string, unknown>): Promise<string> {
  const rows = await adminQuery<{ result: string }>(
    "select public.apply_rebill_event($1::jsonb)->>'result' as result",
    [JSON.stringify(event)],
  );
  return rows[0]!.result;
}

async function checkout(userId: string, product: string, link: string) {
  const created = await commitAs<{ result: string; checkout_id: string; amount_usd: number }>(
    { role: "authenticated", sub: userId },
    `select r->>'result' as result,
            r->>'checkout_id' as checkout_id,
            (r->>'amount_usd')::int as amount_usd
       from (select public.create_own_rebill_checkout($1) as r) s`,
    [product],
  );
  expect(created.error).toBeNull();
  expect(created.rows[0]?.result).toBe("created");
  const attached = await adminQuery<{ result: string }>(
    "select public.attach_own_rebill_checkout_link($1::uuid, $2)->>'result' as result",
    [created.rows[0]!.checkout_id, link],
  );
  expect(attached[0]?.result).toBe("attached");
  return {
    id: created.rows[0]!.checkout_id,
    amount: created.rows[0]!.amount_usd,
  };
}

function payment(input: {
  logId: string;
  paymentId: string;
  status: string;
  amount: number;
  currency?: string;
  checkoutId?: string;
  linkId?: string;
  subscriptionId?: string;
  userId?: string;
}) {
  return {
    logId: input.logId,
    event: "payment.updated",
    userId: input.userId ?? B,
    payment: {
      id: input.paymentId,
      status: input.status,
      amount: input.amount,
      currency: input.currency ?? "USD",
      checkoutId: input.checkoutId,
      paymentLinkId: input.linkId,
      subscriptionId: input.subscriptionId,
    },
  };
}

type Entitlement = {
  id: string;
  access_type: string;
  status: string;
  starts_at: Date;
  expires_at: Date | null;
  user_id: string;
};

async function entitlement(userId: string): Promise<Entitlement | undefined> {
  const rows = await adminQuery<Entitlement>(
    `select id, access_type, status, starts_at, expires_at, user_id
       from public.access_entitlements
      where user_id = $1 and source = 'rebill'`,
    [userId],
  );
  return rows[0];
}

d("rebill apply", () => {
  beforeAll(async () => {
    await setupDatabase();
    for (const id of [
      A,
      B,
      ANNUAL,
      PACK,
      REFUND,
      UPGRADE,
      DOWN,
      LAPSE,
      SLICE,
      GAP,
      YEAR,
      PACKCB,
      WEEKLY,
      LEAK,
      LEAKCB,
      PACKS,
      WEEKEX,
      AFTER,
      KEEP,
      RENEW,
      MID,
      LEGACY,
      STAY,
      PASTDUE,
    ]) {
      await makeUser(id);
    }
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("prices checkouts from config and does not grant access", async () => {
    const monthly = await checkout(A, "pro_monthly", "pl_promontha");
    expect(monthly.amount).toBe(PLAN_PRICES.pro.monthlyUsd);
    const annual = await checkout(ANNUAL, "pro_annual", "pl_proyear");
    expect(annual.amount).toBe(PLAN_PRICES.pro.annualPerMonthUsd * 12);
    const maxAnnual = await commitAs<{ amount: number }>(
      { role: "authenticated", sub: B },
      `select (public.create_own_rebill_checkout('max_annual')->>'amount_usd')::int as amount`,
    );
    expect(maxAnnual.rows[0]?.amount).toBe(PLAN_PRICES.max.annualPerMonthUsd * 12);
    expect(await entitlement(A)).toBeUndefined();
    expect(await balanceOf(A)).toBe(CREDITS_CONFIG.freeWeeklyCredits);

    const forged = await queryAs(
      { role: "authenticated", sub: B },
      "select public.apply_rebill_event($1::jsonb)",
      [JSON.stringify({ logId: "nope", event: "payment.created", userId: A })],
    );
    expect(forged.error?.message ?? "").toMatch(/permission denied/i);
    const otherCheckout = await queryAs(
      { role: "authenticated", sub: B },
      "select id from public.rebill_checkouts where user_id = $1",
      [A],
    );
    expect(otherCheckout.error).toBeNull();
    expect(otherCheckout.rows).toHaveLength(0);
    const events = await queryAs(
      { role: "authenticated", sub: A },
      "select log_id from public.rebill_webhook_events",
    );
    expect(events.error?.message ?? "").toMatch(/permission denied/i);
    const catalog = await queryAs(
      { role: "authenticated", sub: A },
      "select public.record_rebill_plan_id('pro_monthly', 'pln_x')",
    );
    expect(catalog.error?.message ?? "").toMatch(/permission denied/i);
  });

  it("does not treat a payment or subscription insert as access", async () => {
    await adminQuery(
      `insert into public.purchases
         (user_id, provider, provider_transaction_id, product_type, amount, currency, status)
       values ($1, 'rebill', 'pay_inserted', 'plan', 30, 'USD', 'approved')`,
      [A],
    );
    await adminQuery(
      `insert into public.subscriptions
         (user_id, provider, provider_subscription_id, plan_code, plan_tier, status, price_paid, currency)
       values ($1, 'rebill', 'sub_inserted', 'pro_monthly', 'pro', 'active', 30, 'USD')`,
      [B],
    );
    expect(await entitlement(A)).toBeUndefined();
    expect(await entitlement(B)).toBeUndefined();
    const pro = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [A]);
    expect(pro[0]?.v).toBe(false);
  });

  it("grants Pro from a verified payment, ignores a forged user, and does not extend twice", async () => {
    const row = await checkout(A, "pro_monthly", "pl_propay");
    const first = await apply(
      payment({
        logId: "log_pay_1",
        paymentId: "pay_month1",
        status: "approved",
        amount: row.amount,
        checkoutId: row.id,
        linkId: "pl_propay",
        subscriptionId: "sub_montha",
        userId: B,
      }),
    );
    expect(first).toBe("applied");
    const ent = await entitlement(A);
    expect(ent?.access_type).toBe("pro");
    expect(ent?.status).toBe("active");
    expect(ent?.user_id).toBe(A);
    const span = ent!.expires_at!.getTime() - ent!.starts_at.getTime();
    expect(span).toBeGreaterThan(29 * 86400_000);
    expect(span).toBeLessThan(31 * 86400_000);
    expect(await balanceOf(A)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro,
    );
    expect(await entitlement(B)).toBeUndefined();

    const replay = await apply(
      payment({
        logId: "log_pay_1b",
        paymentId: "pay_month1",
        status: "approved",
        amount: row.amount,
        checkoutId: row.id,
        linkId: "pl_propay",
        subscriptionId: "sub_montha",
      }),
    );
    expect(replay).toBe("already_applied");
    const same = await entitlement(A);
    expect(same?.expires_at?.getTime()).toBe(ent?.expires_at?.getTime());
    expect(await planGrants(A)).toBe(1);

    const duplicate = await apply(
      payment({
        logId: "log_pay_1",
        paymentId: "pay_month1",
        status: "approved",
        amount: row.amount,
        subscriptionId: "sub_montha",
      }),
    );
    expect(duplicate).toBe("duplicate");
  });

  it("does not extend on a failed payment, and a later success adds 30 days", async () => {
    const before = await entitlement(A);
    const failed = await apply(
      payment({
        logId: "log_fail_1",
        paymentId: "pay_fail1",
        status: "rejected",
        amount: PLAN_PRICES.pro.monthlyUsd,
        subscriptionId: "sub_montha",
      }),
    );
    expect(failed).toBe("past_due");
    const mid = await entitlement(A);
    expect(mid?.expires_at?.getTime()).toBe(before?.expires_at?.getTime());
    expect(mid?.status).toBe("active");
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_montha'",
    );
    expect(sub[0]?.status).toBe("past_due");
    expect(await planGrants(A)).toBe(1);

    const again = await checkout(A, "pro_monthly", "pl_propay2");
    const second = await apply(
      payment({
        logId: "log_pay_2",
        paymentId: "pay_month2",
        status: "approved",
        amount: again.amount,
        checkoutId: again.id,
        linkId: "pl_propay2",
        subscriptionId: "sub_montha",
      }),
    );
    expect(second).toBe("applied");
    const after = await entitlement(A);
    const added = after!.expires_at!.getTime() - before!.expires_at!.getTime();
    expect(added).toBeGreaterThan(29 * 86400_000);
    expect(added).toBeLessThan(31 * 86400_000);
    expect(after?.starts_at.getTime()).toBe(before?.starts_at.getTime());
    expect(await planGrants(A)).toBe(1);
    const restored = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_montha'",
    );
    expect(restored[0]?.status).toBe("active");
  });

  it("refuses an underpayment and a non-USD charge", async () => {
    const row = await checkout(A, "pro_monthly", "pl_under");
    expect(
      await apply(
        payment({
          logId: "log_under",
          paymentId: "pay_under",
          status: "approved",
          amount: row.amount - 1,
          checkoutId: row.id,
          linkId: "pl_under",
          subscriptionId: "sub_under",
        }),
      ),
    ).toBe("amount_mismatch");
    expect(
      await apply(
        payment({
          logId: "log_eur",
          paymentId: "pay_eur",
          status: "approved",
          amount: row.amount,
          currency: "EUR",
          checkoutId: row.id,
          linkId: "pl_under",
          subscriptionId: "sub_eur",
        }),
      ),
    ).toBe("amount_mismatch");
    expect(await planGrants(A)).toBe(1);
  });

  it("renews annual credits every 30 days inside the paid year without another payment", async () => {
    const row = await checkout(ANNUAL, "pro_annual", "pl_proyearpay");
    expect(
      await apply(
        payment({
          logId: "log_year",
          paymentId: "pay_year1",
          status: "approved",
          amount: row.amount,
          checkoutId: row.id,
          linkId: "pl_proyearpay",
          subscriptionId: "sub_yeara",
        }),
      ),
    ).toBe("applied");
    const ent = await entitlement(ANNUAL);
    const span = ent!.expires_at!.getTime() - ent!.starts_at.getTime();
    expect(span).toBeGreaterThan(360 * 86400_000);
    expect(span).toBeLessThan(370 * 86400_000);
    expect(await balanceOf(ANNUAL)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro,
    );
    await adminQuery(
      "update public.access_entitlements set starts_at = now() - interval '31 days' where id = $1",
      [ent!.id],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [ANNUAL]);
    expect(await planGrants(ANNUAL)).toBe(2);
    expect(await balanceOf(ANNUAL)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro,
    );
    const still = await entitlement(ANNUAL);
    expect(still?.status).toBe("active");
    await adminQuery("select public.ensure_credit_grants($1)", [ANNUAL]);
    expect(await planGrants(ANNUAL)).toBe(2);
  });

  it("grants a pack once and a refund reverses only unused credits", async () => {
    const row = await checkout(PACK, "pack_50", "pl_pack50");
    expect(row.amount).toBe(10);
    expect(
      await apply(
        payment({
          logId: "log_pack",
          paymentId: "pay_pack50",
          status: "approved",
          amount: 10,
          checkoutId: row.id,
          linkId: "pl_pack50",
        }),
      ),
    ).toBe("applied");
    expect(await balanceOf(PACK)).toBe(CREDITS_CONFIG.freeWeeklyCredits + 50);
    expect(await entitlement(PACK)).toBeUndefined();
    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       values ($1, -50, 'unlock', 'spend-pack')`,
      [PACK],
    );
    expect(
      await apply({
        logId: "log_pack_refund",
        event: "payment.updated",
        userId: A,
        payment: { id: "pay_pack50", status: "refunded", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(PACK)).toBe(0);
    expect(
      await apply({
        logId: "log_pack_refund_again",
        event: "payment.updated",
        payment: { id: "pay_pack50", status: "refunded", amount: 10, currency: "USD" },
      }),
    ).toBe("already_revoked");
    expect(await balanceOf(PACK)).toBe(0);
    expect(
      await apply({
        logId: "log_pack_refund_2",
        event: "payment.updated",
        payment: { id: "pay_pack50", status: "chargeback", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    const reversals = await adminQuery<{ n: number; rows: number }>(
      `select coalesce(sum(delta), 0)::int as n, count(*)::int as rows
         from public.credit_ledger
        where user_id = $1
          and (
            idempotency_key = 'rebill_revoke:pay_pack50'
            or idempotency_key = 'rebill_revoke:pay_pack50:chargeback'
          )`,
      [PACK],
    );
    expect(reversals[0]?.n).toBe(-50);
    expect(reversals[0]?.rows).toBe(2);
    expect(await balanceOf(PACK)).toBe(CREDITS_CONFIG.freeWeeklyCredits - 50);
    expect(
      await apply({
        logId: "log_pack_refund_3",
        event: "payment.updated",
        payment: { id: "pay_pack50", status: "chargeback", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(PACK)).toBe(CREDITS_CONFIG.freeWeeklyCredits - 50);
  });

  it("revokes a plan on chargeback and does not grant after a refund that arrived first", async () => {
    const row = await checkout(REFUND, "max_monthly", "pl_maxrefund");
    expect(row.amount).toBe(PLAN_PRICES.max.monthlyUsd);
    expect(
      await apply(
        payment({
          logId: "log_max",
          paymentId: "pay_max1",
          status: "approved",
          amount: row.amount,
          checkoutId: row.id,
          linkId: "pl_maxrefund",
          subscriptionId: "sub_maxrefund",
        }),
      ),
    ).toBe("applied");
    expect(await balanceOf(REFUND)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.max,
    );
    expect(
      await apply({
        logId: "log_max_cb",
        event: "payment.updated",
        payment: {
          id: "pay_max1",
          status: "chargeback",
          amount: row.amount,
          currency: "USD",
        },
      }),
    ).toBe("revoked");
    const ent = await entitlement(REFUND);
    expect(ent?.status).toBe("revoked");
    const pro = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [
      REFUND,
    ]);
    expect(pro[0]?.v).toBe(false);
    expect(await balanceOf(REFUND)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_maxrefund'",
    );
    expect(sub[0]?.status).toBe("canceled");

    const early = await checkout(REFUND, "pro_monthly", "pl_earlyrefund");
    expect(
      await apply({
        logId: "log_early_refund",
        event: "payment.updated",
        payment: { id: "pay_early", status: "refunded", amount: 30, currency: "USD" },
      }),
    ).toBe("refund_without_grant");
    expect(
      await apply(
        payment({
          logId: "log_early_pay",
          paymentId: "pay_early",
          status: "approved",
          amount: early.amount,
          checkoutId: early.id,
          linkId: "pl_earlyrefund",
          subscriptionId: "sub_early",
        }),
      ),
    ).toBe("refunded_before_grant");
    expect(await planGrants(REFUND)).toBe(1);
  });

  it("switches Pro to Max immediately without a second grant, then grants Max next period", async () => {
    const row = await checkout(UPGRADE, "pro_monthly", "pl_upgrade");
    expect(
      await apply(
        payment({
          logId: "log_up",
          paymentId: "pay_up",
          status: "approved",
          amount: row.amount,
          checkoutId: row.id,
          linkId: "pl_upgrade",
          subscriptionId: "sub_upgrade",
        }),
      ),
    ).toBe("applied");
    const before = await entitlement(UPGRADE);
    expect(
      await apply({
        logId: "log_up_plan",
        event: "subscription.updated",
        userId: B,
        subscription: {
          id: "sub_upgrade",
          status: "active",
          planUpdated: true,
          productCode: "max_monthly",
        },
      }),
    ).toBe("subscription_updated");
    const after = await entitlement(UPGRADE);
    expect(after?.access_type).toBe("max");
    expect(after?.expires_at?.getTime()).toBe(before?.expires_at?.getTime());
    expect(await planGrants(UPGRADE)).toBe(1);
    await adminQuery(
      "update public.access_entitlements set starts_at = now() - interval '31 days' where id = $1",
      [after!.id],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [UPGRADE]);
    expect(await planGrants(UPGRADE)).toBe(2);
    expect(await balanceOf(UPGRADE)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.max,
    );
  });

  it("keeps access until period end on cancel, and grants again after a lapsed window is paid", async () => {
    const row = await checkout(DOWN, "max_monthly", "pl_down");
    expect(
      await apply(
        payment({
          logId: "log_down",
          paymentId: "pay_down",
          status: "approved",
          amount: row.amount,
          checkoutId: row.id,
          linkId: "pl_down",
          subscriptionId: "sub_down",
        }),
      ),
    ).toBe("applied");
    const before = await entitlement(DOWN);
    expect(
      await apply({
        logId: "log_cancel",
        event: "subscription.updated",
        subscription: { id: "sub_down", status: "cancelled", statusDetail: null },
      }),
    ).toBe("subscription_updated");
    const after = await entitlement(DOWN);
    expect(after?.status).toBe("active");
    expect(after?.expires_at?.getTime()).toBe(before?.expires_at?.getTime());
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_down'",
    );
    expect(sub[0]?.status).toBe("canceled");

    const lapse = await checkout(LAPSE, "pro_monthly", "pl_lapse");
    expect(
      await apply(
        payment({
          logId: "log_lapse_1",
          paymentId: "pay_lapse1",
          status: "approved",
          amount: lapse.amount,
          checkoutId: lapse.id,
          linkId: "pl_lapse",
          subscriptionId: "sub_lapse",
        }),
      ),
    ).toBe("applied");
    const first = await entitlement(LAPSE);
    await adminQuery(
      `update public.access_entitlements
          set starts_at = now() - interval '40 days',
              expires_at = now() - interval '1 minute'
        where id = $1`,
      [first!.id],
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const next = await checkout(LAPSE, "pro_monthly", "pl_lapse2");
    expect(
      await apply(
        payment({
          logId: "log_lapse_2",
          paymentId: "pay_lapse2",
          status: "approved",
          amount: next.amount,
          checkoutId: next.id,
          linkId: "pl_lapse2",
          subscriptionId: "sub_lapse",
        }),
      ),
    ).toBe("applied");
    expect(await planGrants(LAPSE)).toBe(2);
    const reopened = await entitlement(LAPSE);
    expect(reopened?.status).toBe("active");
    expect(reopened!.expires_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not expire a manual entitlement and refuses a user conflict", async () => {
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, expires_at, source, source_reference)
       values ($1, 'pro', 'active', now() - interval '40 days', now() - interval '1 day', 'test', 'manual-pro')`,
      [B],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [B]);
    const manual = await adminQuery<{ status: string }>(
      "select status from public.access_entitlements where source_reference = 'manual-pro'",
    );
    expect(manual[0]?.status).toBe("active");

    expect(
      await apply(
        payment({
          logId: "log_conflict",
          paymentId: "pay_conflict",
          status: "approved",
          amount: 30,
          checkoutId: (await checkout(A, "pro_monthly", "pl_conflict")).id,
          linkId: "pl_conflict",
          subscriptionId: "sub_inserted",
        }),
      ),
    ).toBe("user_conflict");
  });

  it("does not let a signed-in user attach a link or read unused credits", async () => {
    const created = await commitAs<{ checkout_id: string }>(
      { role: "authenticated", sub: SLICE },
      `select public.create_own_rebill_checkout('pro_monthly')->>'checkout_id' as checkout_id`,
    );
    const checkoutId = created.rows[0]!.checkout_id;
    for (const role of ["authenticated", "anon"] as const) {
      const attached = await queryAs(
        { role, sub: role === "authenticated" ? SLICE : null },
        "select public.attach_own_rebill_checkout_link($1::uuid, 'pl_denied')",
        [checkoutId],
      );
      expect(attached.error?.message ?? "").toMatch(/permission denied/i);
      const unused = await queryAs(
        { role, sub: role === "authenticated" ? SLICE : null },
        "select public.rebill_unused_credits($1::uuid, null, 'plan')",
        [SLICE],
      );
      expect(unused.error?.message ?? "").toMatch(/permission denied/i);
    }
    const server = await adminQuery<{ result: string }>(
      "select public.attach_own_rebill_checkout_link($1::uuid, 'pl_denied')->>'result' as result",
      [checkoutId],
    );
    expect(server[0]?.result).toBe("attached");
  });

  it("refunds only the monthly slice that payment bought", async () => {
    const other = await balanceOf(B);
    const first = await checkout(SLICE, "pro_monthly", "pl_slicea");
    expect(
      await apply(
        payment({
          logId: "log_slice1",
          paymentId: "pay_slice1",
          status: "approved",
          amount: first.amount,
          checkoutId: first.id,
          linkId: "pl_slicea",
          subscriptionId: "sub_slicea",
        }),
      ),
    ).toBe("applied");
    const second = await checkout(SLICE, "pro_monthly", "pl_sliceb");
    expect(
      await apply(
        payment({
          logId: "log_slice2",
          paymentId: "pay_slice2",
          status: "approved",
          amount: second.amount,
          checkoutId: second.id,
          linkId: "pl_sliceb",
          subscriptionId: "sub_slicea",
        }),
      ),
    ).toBe("applied");
    const extended = await entitlement(SLICE);
    const extendedDays =
      (extended!.expires_at!.getTime() - extended!.starts_at.getTime()) / 86400_000;
    expect(extendedDays).toBeGreaterThan(58);
    expect(extendedDays).toBeLessThan(62);
    expect(await planGrants(SLICE)).toBe(1);
    const paid = await balanceOf(SLICE);

    expect(
      await apply({
        logId: "log_slice2_partial",
        event: "payment.updated",
        payment: {
          id: "pay_slice2",
          status: "partially_refunded",
          amount: second.amount,
          currency: "USD",
        },
      }),
    ).toBe("revoked");
    const shortened = await entitlement(SLICE);
    const shortenedDays =
      (shortened!.expires_at!.getTime() - shortened!.starts_at.getTime()) / 86400_000;
    expect(shortened?.status).toBe("active");
    expect(shortenedDays).toBeGreaterThan(28);
    expect(shortenedDays).toBeLessThan(32);
    expect(await balanceOf(SLICE)).toBe(paid);
    expect(await planGrants(SLICE)).toBe(1);
    const tail = await adminQuery<{ effect: string }>(
      "select effect from public.rebill_payment_effects where payment_id = 'pay_slice1'",
    );
    expect(tail[0]?.effect).toBe("granted");

    const current = await checkout(GAP, "pro_monthly", "pl_gapa");
    expect(
      await apply(
        payment({
          logId: "log_gap1",
          paymentId: "pay_gap1",
          status: "approved",
          amount: current.amount,
          checkoutId: current.id,
          linkId: "pl_gapa",
          subscriptionId: "sub_gapa",
        }),
      ),
    ).toBe("applied");
    const later = await checkout(GAP, "pro_monthly", "pl_gapb");
    expect(
      await apply(
        payment({
          logId: "log_gap2",
          paymentId: "pay_gap2",
          status: "approved",
          amount: later.amount,
          checkoutId: later.id,
          linkId: "pl_gapb",
          subscriptionId: "sub_gapa",
        }),
      ),
    ).toBe("applied");
    expect(
      await apply({
        logId: "log_gap1_refund",
        event: "payment.updated",
        payment: { id: "pay_gap1", status: "refunded", amount: current.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    const gapped = await entitlement(GAP);
    expect(gapped?.status).toBe("active");
    expect(gapped!.starts_at.getTime()).toBeGreaterThan(Date.now() + 20 * 86400_000);
    const active = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [
      GAP,
    ]);
    expect(active[0]?.v).toBe(false);
    expect(await balanceOf(GAP)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    const kept = await adminQuery<{ effect: string }>(
      "select effect from public.rebill_payment_effects where payment_id = 'pay_gap2'",
    );
    expect(kept[0]?.effect).toBe("granted");
    const gapSub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_gapa'",
    );
    expect(gapSub[0]?.status).toBe("active");
    expect(await balanceOf(B)).toBe(other);

    expect(
      await apply({
        logId: "log_gap2_dispute",
        event: "payment.updated",
        payment: { id: "pay_gap2", status: "chargeback", amount: later.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    const disputed = await entitlement(GAP);
    expect(disputed?.status).toBe("revoked");
    const afterDispute = await adminQuery<{ v: boolean }>(
      "select public._has_active_pro($1) as v",
      [GAP],
    );
    expect(afterDispute[0]?.v).toBe(false);
    const canceled = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_gapa'",
    );
    expect(canceled[0]?.status).toBe("canceled");
    expect(await balanceOf(B)).toBe(other);
  });

  it("ends an annual plan on refund and reverses every unused plan credit", async () => {
    const row = await checkout(YEAR, "pro_annual", "pl_yearrefund");
    expect(
      await apply(
        payment({
          logId: "log_year_refund_pay",
          paymentId: "pay_yearrefund",
          status: "approved",
          amount: row.amount,
          checkoutId: row.id,
          linkId: "pl_yearrefund",
          subscriptionId: "sub_yearrefund",
        }),
      ),
    ).toBe("applied");
    const ent = await entitlement(YEAR);
    await adminQuery(
      "update public.access_entitlements set starts_at = now() - interval '31 days' where id = $1",
      [ent!.id],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [YEAR]);
    expect(await planGrants(YEAR)).toBe(2);
    expect(
      await apply({
        logId: "log_year_refund",
        event: "payment.updated",
        payment: { id: "pay_yearrefund", status: "refunded", amount: row.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    const ended = await entitlement(YEAR);
    expect(ended?.status).toBe("expired");
    expect(ended!.expires_at!.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
    const active = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [
      YEAR,
    ]);
    expect(active[0]?.v).toBe(false);
    expect(await balanceOf(YEAR)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_yearrefund'",
    );
    expect(sub[0]?.status).toBe("canceled");
  });

  it("lets a pack chargeback reverse the full grant below zero", async () => {
    const row = await checkout(PACKCB, "pack_50", "pl_packcb");
    expect(
      await apply(
        payment({
          logId: "log_packcb",
          paymentId: "pay_packcb",
          status: "approved",
          amount: 10,
          checkoutId: row.id,
          linkId: "pl_packcb",
        }),
      ),
    ).toBe("applied");
    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       values ($1, -50, 'unlock', 'spend-packcb')`,
      [PACKCB],
    );
    expect(
      await apply({
        logId: "log_packcb_dispute",
        event: "payment.updated",
        payment: { id: "pay_packcb", status: "chargeback", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(PACKCB)).toBe(CREDITS_CONFIG.freeWeeklyCredits - 50);
  });

  it("resumes free weekly credits when a paid plan ends", async () => {
    await adminQuery(
      "update public.users set created_at = now() - interval '8 days' where id = $1",
      [WEEKLY],
    );
    const row = await checkout(WEEKLY, "pro_monthly", "pl_weekly");
    expect(
      await apply(
        payment({
          logId: "log_weekly_pay",
          paymentId: "pay_weekly",
          status: "approved",
          amount: row.amount,
          checkoutId: row.id,
          linkId: "pl_weekly",
          subscriptionId: "sub_weekly",
        }),
      ),
    ).toBe("applied");
    const during = await adminQuery<{ n: number }>(
      `select count(*)::int as n from public.credit_ledger
        where user_id = $1 and idempotency_key = 'free_weekly:1'`,
      [WEEKLY],
    );
    expect(during[0]?.n).toBe(0);
    expect(
      await apply({
        logId: "log_weekly_refund",
        event: "payment.updated",
        payment: { id: "pay_weekly", status: "refunded", amount: row.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    const ent = await entitlement(WEEKLY);
    expect(ent?.status).toBe("expired");
    const active = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [
      WEEKLY,
    ]);
    expect(active[0]?.v).toBe(false);
    const after = await adminQuery<{ n: number }>(
      `select count(*)::int as n from public.credit_ledger
        where user_id = $1 and idempotency_key = 'free_weekly:1' and delta > 0`,
      [WEEKLY],
    );
    expect(after[0]?.n).toBe(1);
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_weekly'",
    );
    expect(sub[0]?.status).toBe("expired");
  });

  it("does not restore a refunded pack on the next plan period", async () => {
    const pro = await checkout(LEAK, "pro_monthly", "pl_leakpro");
    expect(
      await apply(
        payment({
          logId: "log_leak_pro",
          paymentId: "pay_leakpro",
          status: "approved",
          amount: pro.amount,
          checkoutId: pro.id,
          linkId: "pl_leakpro",
          subscriptionId: "sub_leakpro",
        }),
      ),
    ).toBe("applied");
    const pack = await checkout(LEAK, "pack_50", "pl_leakpack");
    expect(
      await apply(
        payment({
          logId: "log_leak_pack",
          paymentId: "pay_leakpack",
          status: "approved",
          amount: 10,
          checkoutId: pack.id,
          linkId: "pl_leakpack",
        }),
      ),
    ).toBe("applied");
    expect(await balanceOf(LEAK)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro + 50,
    );
    expect(
      await apply({
        logId: "log_leak_refund",
        event: "payment.updated",
        payment: { id: "pay_leakpack", status: "refunded", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(LEAK)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro,
    );
    const ent = await entitlement(LEAK);
    await adminQuery(
      "update public.access_entitlements set starts_at = now() - interval '31 days' where id = $1",
      [ent!.id],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [LEAK]);
    expect(await balanceOf(LEAK)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro,
    );
    expect(await planGrants(LEAK)).toBe(2);
  });

  it("does not restore a pack chargeback on the next plan period", async () => {
    const pro = await checkout(LEAKCB, "pro_monthly", "pl_leakcb");
    expect(
      await apply(
        payment({
          logId: "log_leakcb_pro",
          paymentId: "pay_leakcb",
          status: "approved",
          amount: pro.amount,
          checkoutId: pro.id,
          linkId: "pl_leakcb",
          subscriptionId: "sub_leakcb",
        }),
      ),
    ).toBe("applied");
    const pack = await checkout(LEAKCB, "pack_50", "pl_leakcbp");
    expect(
      await apply(
        payment({
          logId: "log_leakcb_pack",
          paymentId: "pay_leakpk",
          status: "approved",
          amount: 10,
          checkoutId: pack.id,
          linkId: "pl_leakcbp",
        }),
      ),
    ).toBe("applied");
    expect(
      await apply({
        logId: "log_leakcb_dispute",
        event: "payment.updated",
        payment: { id: "pay_leakpk", status: "chargeback", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(LEAKCB)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro,
    );
    const ent = await entitlement(LEAKCB);
    await adminQuery(
      "update public.access_entitlements set starts_at = now() - interval '31 days' where id = $1",
      [ent!.id],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [LEAKCB]);
    expect(await balanceOf(LEAKCB)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro,
    );
  });

  it("refunds two unused packs down to the weekly balance", async () => {
    const first = await checkout(PACKS, "pack_50", "pl_twopaka");
    expect(
      await apply(
        payment({
          logId: "log_twopaka",
          paymentId: "pay_twopaka",
          status: "approved",
          amount: 10,
          checkoutId: first.id,
          linkId: "pl_twopaka",
        }),
      ),
    ).toBe("applied");
    const second = await checkout(PACKS, "pack_50", "pl_twopakb");
    expect(
      await apply(
        payment({
          logId: "log_twopakb",
          paymentId: "pay_twopakb",
          status: "approved",
          amount: 10,
          checkoutId: second.id,
          linkId: "pl_twopakb",
        }),
      ),
    ).toBe("applied");
    expect(await balanceOf(PACKS)).toBe(CREDITS_CONFIG.freeWeeklyCredits + 100);
    expect(
      await apply({
        logId: "log_twopakb_refund",
        event: "payment.updated",
        payment: { id: "pay_twopakb", status: "refunded", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(PACKS)).toBe(CREDITS_CONFIG.freeWeeklyCredits + 50);
    expect(
      await apply({
        logId: "log_twopaka_refund",
        event: "payment.updated",
        payment: { id: "pay_twopaka", status: "refunded", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(PACKS)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
  });

  it("expires the full weekly grant after a pack refund", async () => {
    await adminQuery(
      "update public.users set created_at = now() - interval '8 days' where id = $1",
      [WEEKEX],
    );
    const pack = await checkout(WEEKEX, "pack_50", "pl_weekex");
    expect(
      await apply(
        payment({
          logId: "log_weekex",
          paymentId: "pay_weekex",
          status: "approved",
          amount: 10,
          checkoutId: pack.id,
          linkId: "pl_weekex",
        }),
      ),
    ).toBe("applied");
    expect(
      await apply({
        logId: "log_weekex_refund",
        event: "payment.updated",
        payment: { id: "pay_weekex", status: "refunded", amount: 10, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(WEEKEX)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    await adminQuery("select public.ensure_credit_grants($1)", [WEEKEX]);
    expect(await balanceOf(WEEKEX)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    const next = await adminQuery<{ n: number }>(
      `select count(*)::int as n from public.credit_ledger
        where user_id = $1 and idempotency_key = 'free_weekly:1' and delta > 0`,
      [WEEKEX],
    );
    expect(next[0]?.n).toBe(1);
  });

  it("revokes the subscription when a chargeback follows a refund", async () => {
    const row = await checkout(AFTER, "pro_monthly", "pl_after");
    expect(
      await apply(
        payment({
          logId: "log_after_pay",
          paymentId: "pay_after1",
          status: "approved",
          amount: row.amount,
          checkoutId: row.id,
          linkId: "pl_after",
          subscriptionId: "sub_after",
        }),
      ),
    ).toBe("applied");
    expect(
      await apply({
        logId: "log_after_refund",
        event: "payment.updated",
        payment: { id: "pay_after1", status: "refunded", amount: row.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(
      await apply({
        logId: "log_after_dispute",
        event: "payment.updated",
        payment: { id: "pay_after1", status: "chargeback", amount: row.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    const ent = await entitlement(AFTER);
    expect(ent?.status).toBe("revoked");
    const active = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [
      AFTER,
    ]);
    expect(active[0]?.v).toBe(false);
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_after'",
    );
    expect(sub[0]?.status).toBe("canceled");
  });

  it("does not reopen access a chargeback revoked or a cancel closed", async () => {
    const first = await checkout(KEEP, "pro_monthly", "pl_keepa");
    expect(
      await apply(
        payment({
          logId: "log_keep1",
          paymentId: "pay_keepa",
          status: "approved",
          amount: first.amount,
          checkoutId: first.id,
          linkId: "pl_keepa",
          subscriptionId: "sub_keep",
        }),
      ),
    ).toBe("applied");
    const second = await checkout(KEEP, "pro_monthly", "pl_keepb");
    expect(
      await apply(
        payment({
          logId: "log_keep2",
          paymentId: "pay_keepb",
          status: "approved",
          amount: second.amount,
          checkoutId: second.id,
          linkId: "pl_keepb",
          subscriptionId: "sub_keep",
        }),
      ),
    ).toBe("applied");
    expect(
      await apply({
        logId: "log_keep_dispute",
        event: "payment.updated",
        payment: { id: "pay_keepa", status: "chargeback", amount: first.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(
      await apply({
        logId: "log_keep_refund",
        event: "payment.updated",
        payment: { id: "pay_keepb", status: "refunded", amount: second.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    const kept = await entitlement(KEEP);
    expect(kept?.status).toBe("revoked");
    const active = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [
      KEEP,
    ]);
    expect(active[0]?.v).toBe(false);
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_keep'",
    );
    expect(sub[0]?.status).toBe("canceled");

    const stay1 = await checkout(STAY, "pro_monthly", "pl_staya");
    expect(
      await apply(
        payment({
          logId: "log_stay1",
          paymentId: "pay_staya",
          status: "approved",
          amount: stay1.amount,
          checkoutId: stay1.id,
          linkId: "pl_staya",
          subscriptionId: "sub_stay",
        }),
      ),
    ).toBe("applied");
    const stay2 = await checkout(STAY, "pro_monthly", "pl_stayb");
    expect(
      await apply(
        payment({
          logId: "log_stay2",
          paymentId: "pay_stayb",
          status: "approved",
          amount: stay2.amount,
          checkoutId: stay2.id,
          linkId: "pl_stayb",
          subscriptionId: "sub_stay",
        }),
      ),
    ).toBe("applied");
    expect(
      await apply({
        logId: "log_stay_cancel",
        event: "subscription.updated",
        subscription: { id: "sub_stay", status: "cancelled", statusDetail: null },
      }),
    ).toBe("subscription_updated");
    expect(
      await apply({
        logId: "log_stay_refund",
        event: "payment.updated",
        payment: { id: "pay_stayb", status: "refunded", amount: stay2.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    const stayEnt = await entitlement(STAY);
    expect(stayEnt?.status).toBe("active");
    const staySpan = stayEnt!.expires_at!.getTime() - stayEnt!.starts_at.getTime();
    expect(staySpan).toBeGreaterThan(28 * 86400_000);
    expect(staySpan).toBeLessThan(32 * 86400_000);
    const staySub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_stay'",
    );
    expect(staySub[0]?.status).toBe("canceled");
  });

  it("links an early renewal to the next period grant", async () => {
    const first = await checkout(RENEW, "pro_monthly", "pl_renewa");
    expect(
      await apply(
        payment({
          logId: "log_renew1",
          paymentId: "pay_renewa",
          status: "approved",
          amount: first.amount,
          checkoutId: first.id,
          linkId: "pl_renewa",
          subscriptionId: "sub_renew",
        }),
      ),
    ).toBe("applied");
    const second = await checkout(RENEW, "pro_monthly", "pl_renewb");
    expect(
      await apply(
        payment({
          logId: "log_renew2",
          paymentId: "pay_renewb",
          status: "approved",
          amount: second.amount,
          checkoutId: second.id,
          linkId: "pl_renewb",
          subscriptionId: "sub_renew",
        }),
      ),
    ).toBe("applied");
    const keys = await adminQuery<{ payment_id: string; grant_key: string }>(
      `select payment_id, grant_key
         from public.rebill_payment_effects
        where user_id = $1
        order by created_at, payment_id`,
      [RENEW],
    );
    expect(keys[0]?.grant_key.endsWith(":0")).toBe(true);
    expect(keys[1]?.grant_key.endsWith(":1")).toBe(true);
    expect(keys[0]?.grant_key).not.toBe(keys[1]?.grant_key);
    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       values ($1, $2, 'plan_grant', $3)`,
      [RENEW, CREDITS_CONFIG.planMonthlyCredits.pro, keys[1]!.grant_key],
    );
    expect(await balanceOf(RENEW)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro * 2,
    );
    expect(
      await apply({
        logId: "log_renew_refund",
        event: "payment.updated",
        payment: { id: "pay_renewb", status: "refunded", amount: second.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    expect(await balanceOf(RENEW)).toBe(
      CREDITS_CONFIG.freeWeeklyCredits + CREDITS_CONFIG.planMonthlyCredits.pro,
    );
    const kept = await adminQuery<{ effect: string }>(
      "select effect from public.rebill_payment_effects where payment_id = 'pay_renewa'",
    );
    expect(kept[0]?.effect).toBe("granted");
    const ent = await entitlement(RENEW);
    const span = ent!.expires_at!.getTime() - ent!.starts_at.getTime();
    expect(span).toBeGreaterThan(28 * 86400_000);
    expect(span).toBeLessThan(32 * 86400_000);
  });

  it("shortens a middle prepaid slice without dropping the later one", async () => {
    const amounts: number[] = [];
    for (const [n, link, pay] of [
      ["1", "pl_mida", "pay_mida"],
      ["2", "pl_midb", "pay_midb"],
      ["3", "pl_midc", "pay_midc"],
    ] as const) {
      const row = await checkout(MID, "pro_monthly", link);
      amounts.push(row.amount);
      expect(
        await apply(
          payment({
            logId: `log_mid${n}`,
            paymentId: pay,
            status: "approved",
            amount: row.amount,
            checkoutId: row.id,
            linkId: link,
            subscriptionId: "sub_mid",
          }),
        ),
      ).toBe("applied");
    }
    const before = await entitlement(MID);
    const beforeSpan = before!.expires_at!.getTime() - before!.starts_at.getTime();
    expect(beforeSpan).toBeGreaterThan(88 * 86400_000);
    const paid = await balanceOf(MID);
    expect(
      await apply({
        logId: "log_mid_refund",
        event: "payment.updated",
        payment: {
          id: "pay_midb",
          status: "partially_refunded",
          amount: amounts[1],
          currency: "USD",
        },
      }),
    ).toBe("revoked");
    const after = await entitlement(MID);
    expect(after?.status).toBe("active");
    const afterSpan = after!.expires_at!.getTime() - after!.starts_at.getTime();
    expect(afterSpan).toBeGreaterThan(58 * 86400_000);
    expect(afterSpan).toBeLessThan(62 * 86400_000);
    const pro = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [MID]);
    expect(pro[0]?.v).toBe(true);
    expect(await balanceOf(MID)).toBe(paid);
    const third = await adminQuery<{ effect: string }>(
      "select effect from public.rebill_payment_effects where payment_id = 'pay_midc'",
    );
    expect(third[0]?.effect).toBe("granted");
  });

  it("ends a pre-slice payment without reopening a canceled subscription", async () => {
    const row = await checkout(LEGACY, "pro_monthly", "pl_legacy");
    expect(
      await apply(
        payment({
          logId: "log_legacy_pay",
          paymentId: "pay_legacy",
          status: "approved",
          amount: row.amount,
          checkoutId: row.id,
          linkId: "pl_legacy",
          subscriptionId: "sub_legacy",
        }),
      ),
    ).toBe("applied");
    expect(
      await apply({
        logId: "log_legacy_cancel",
        event: "subscription.updated",
        subscription: { id: "sub_legacy", status: "cancelled", statusDetail: null },
      }),
    ).toBe("subscription_updated");
    await adminQuery(
      `update public.rebill_payment_effects
          set grant_key = null, slice_start = null, slice_end = null
        where payment_id = 'pay_legacy'`,
    );
    expect(
      await apply({
        logId: "log_legacy_refund",
        event: "payment.updated",
        payment: { id: "pay_legacy", status: "refunded", amount: row.amount, currency: "USD" },
      }),
    ).toBe("revoked");
    const ent = await entitlement(LEGACY);
    expect(ent?.status).toBe("expired");
    const active = await adminQuery<{ v: boolean }>("select public._has_active_pro($1) as v", [
      LEGACY,
    ]);
    expect(active[0]?.v).toBe(false);
    expect(await balanceOf(LEGACY)).toBe(CREDITS_CONFIG.freeWeeklyCredits);
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_legacy'",
    );
    expect(sub[0]?.status).toBe("canceled");
  });

  it("does not flip a past_due subscription to active when a later slice is refunded", async () => {
    const first = await checkout(PASTDUE, "pro_monthly", "pl_pastduea");
    expect(
      await apply(
        payment({
          logId: "log_pastdue_1",
          paymentId: "pay_pastduea",
          status: "approved",
          amount: first.amount,
          checkoutId: first.id,
          linkId: "pl_pastduea",
          subscriptionId: "sub_pastdue",
        }),
      ),
    ).toBe("applied");
    const second = await checkout(PASTDUE, "pro_monthly", "pl_pastdueb");
    expect(
      await apply(
        payment({
          logId: "log_pastdue_2",
          paymentId: "pay_pastdueb",
          status: "approved",
          amount: second.amount,
          checkoutId: second.id,
          linkId: "pl_pastdueb",
          subscriptionId: "sub_pastdue",
        }),
      ),
    ).toBe("applied");
    expect(
      await apply({
        logId: "log_pastdue_mark",
        event: "subscription.updated",
        subscription: { id: "sub_pastdue", status: "paused", statusDetail: "defaulted" },
      }),
    ).toBe("subscription_updated");
    const marked = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_pastdue'",
    );
    expect(marked[0]?.status).toBe("past_due");
    expect(
      await apply({
        logId: "log_pastdue_refund",
        event: "payment.updated",
        payment: {
          id: "pay_pastdueb",
          status: "refunded",
          amount: second.amount,
          currency: "USD",
        },
      }),
    ).toBe("revoked");
    const sub = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = 'sub_pastdue'",
    );
    expect(sub[0]?.status).toBe("past_due");
  });
});
