/**
 * A failed Rebill cancel stays in the admin queue with no user id.
 * Finish is the only way the row goes away. Nothing here refunds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const CREATOR = "c1070000-0000-4000-8000-000000000001";
const ADMIN = "c1070000-0000-4000-8000-000000000002";
const EDITOR = "c1070000-0000-4000-8000-000000000003";
const SUB = "sub_queue107";

d("Rebill cancel queue", () => {
  beforeAll(async () => {
    await setupDatabase();
    for (const id of [CREATOR, ADMIN, EDITOR]) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery("update public.users set role = 'admin' where id = $1", [ADMIN]);
    await adminQuery("update public.users set role = 'editor' where id = $1", [EDITOR]);
    await adminQuery(
      `insert into public.subscriptions
         (user_id, provider, provider_subscription_id, plan_code, plan_tier, status, price_paid, currency)
       values ($1, 'rebill', $2, 'pro_monthly', 'pro', 'active', 30, 'USD')`,
      [CREATOR, SUB],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("keeps a pending cancel visible to an admin and removes it only after finish", async () => {
    const columns = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'private' and table_name = 'rebill_cancel_queue'
        order by column_name`,
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "created_at",
      "reason",
      "subscription_id",
    ]);

    const scheduled = await commitAs<{ r: { result: string; subscription_ids: string[] } }>(
      { role: "authenticated", sub: CREATOR },
      "select public.request_own_account_deletion('DELETE') as r",
    );
    expect(scheduled.error).toBeNull();
    expect(scheduled.rows[0]?.r.result).toBe("scheduled");
    expect(scheduled.rows[0]?.r.subscription_ids).toEqual([SUB]);

    const pending = await adminQuery<{
      subscription_id: string;
      reason: string;
      created_at: Date;
    }>("select subscription_id, reason, created_at from private.rebill_cancel_queue");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.subscription_id).toBe(SUB);
    expect(pending[0]?.reason).toBe("pending");
    expect(pending[0]?.created_at).toBeInstanceOf(Date);
    expect(JSON.stringify(pending)).not.toContain(CREATOR);

    const local = await adminQuery<{ status: string }>(
      "select status from public.subscriptions where provider_subscription_id = $1",
      [SUB],
    );
    expect(local[0]?.status).toBe("canceled");
    const refunds = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.rebill_refund_queue",
    );
    expect(refunds[0]?.n).toBe(0);

    const again = await commitAs(
      { role: "authenticated", sub: CREATOR },
      "select public.request_own_account_deletion('DELETE') as r",
    );
    expect(again.error).toBeNull();
    const still = await adminQuery<{ reason: string; created_at: Date }>(
      "select reason, created_at from private.rebill_cancel_queue where subscription_id = $1",
      [SUB],
    );
    expect(still[0]?.reason).toBe("pending");
    expect(still[0]?.created_at.toISOString()).toBe(pending[0]?.created_at.toISOString());

    const creatorRead = await queryAs(
      { role: "authenticated", sub: CREATOR },
      "select subscription_id from public.read_admin_rebill_cancel_queue(50)",
    );
    expect(creatorRead.error).toBeNull();
    expect(creatorRead.rows).toEqual([]);
    const editorRead = await queryAs(
      { role: "authenticated", sub: EDITOR },
      "select subscription_id from public.read_admin_rebill_cancel_queue(50)",
    );
    expect(editorRead.rows).toEqual([]);
    const adminRead = await queryAs<{ subscription_id: string; reason: string }>(
      { role: "authenticated", sub: ADMIN },
      "select subscription_id, reason from public.read_admin_rebill_cancel_queue(50)",
    );
    expect(adminRead.error).toBeNull();
    expect(adminRead.rows).toEqual([{ subscription_id: SUB, reason: "pending" }]);
    expect(JSON.stringify(adminRead.rows)).not.toContain(CREATOR);

    const anon = await queryAs(
      { role: "anon" },
      "select subscription_id from public.read_admin_rebill_cancel_queue(50)",
    );
    expect(anon.error?.message ?? "").toMatch(/permission denied/i);

    await adminQuery("grant usage on schema public to service_role");
    try {
      const queued = await commitAs(
        { role: "service_role" },
        "select public.rebill_queue_provider_cancel($1, 'provider_error')",
        [SUB],
      );
      expect(queued.error).toBeNull();
      const updated = await adminQuery<{ reason: string; created_at: Date }>(
        "select reason, created_at from private.rebill_cancel_queue where subscription_id = $1",
        [SUB],
      );
      expect(updated[0]?.reason).toBe("provider_error");
      expect(updated[0]?.created_at.toISOString()).toBe(pending[0]?.created_at.toISOString());

      const finished = await commitAs(
        { role: "service_role" },
        "select public.rebill_finish_provider_cancel($1)",
        [SUB],
      );
      expect(finished.error).toBeNull();
    } finally {
      await adminQuery("revoke usage on schema public from service_role");
    }

    const gone = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.rebill_cancel_queue",
    );
    expect(gone[0]?.n).toBe(0);
    const adminAfter = await queryAs(
      { role: "authenticated", sub: ADMIN },
      "select subscription_id from public.read_admin_rebill_cancel_queue(50)",
    );
    expect(adminAfter.rows).toEqual([]);
  });
});
