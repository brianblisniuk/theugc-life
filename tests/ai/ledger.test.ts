/**
 * D03 ledger, usage rows, and selected mail (D143–D145).
 * Claude is not called.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CREDITS_CONFIG } from "@/lib/credits/config";
import { normalizeBatch } from "@/lib/gmail/normalize/service";

import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";
import {
  buildSanitizedMessage,
  connectedMailbox,
  deps,
  insertRawMessage,
  normalizedMessageRow,
  randomProviderId,
} from "../gmail-normalize/harness";

const d = describe.skipIf(!hasTestDb);

const PRO = "d0300000-0000-4000-8000-0000000000a1";
const FREE = "d0300000-0000-4000-8000-0000000000a2";
const PASS = "d0300000-0000-4000-8000-0000000000a3";
const OTHER = "d0300000-0000-4000-8000-0000000000a4";
const DEST = "d0300000-0000-4000-8000-0000000000d1";
const HOTEL = "d0300000-0000-4000-8000-0000000000b1";
const HOTEL_LOCKED = "d0300000-0000-4000-8000-0000000000b2";

function jsonOf(value: unknown): {
  status?: string;
  result?: string;
  weight?: number;
  warning?: string | null;
} {
  if (typeof value === "string") return JSON.parse(value) as { status?: string; weight?: number };
  return (value ?? {}) as { status?: string; weight?: number; warning?: string | null };
}

async function prepare(
  userId: string,
  requestId: string,
  hotelId: string,
  estimate: number,
  budget: number,
  weight = 2,
  floor = 100_000_000,
  bps = 1500,
) {
  const rows = await adminQuery<{ result: unknown }>(
    "select public.prepare_ai_usage($1,$2,'claude-sonnet-5-5',$3,$4,$5,$6,$7,$8) as result",
    [userId, requestId, hotelId, estimate, budget, weight, floor, bps],
  );
  return jsonOf(rows[0]?.result);
}

async function balanceOf(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: number }>(
    "select coalesce(sum(delta), 0)::int as n from public.credit_ledger where user_id = $1",
    [userId],
  );
  return rows[0]!.n;
}

d("AI draft credits and usage", () => {
  beforeAll(async () => {
    await setupDatabase();
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1, 'Draft Bay', 'draft-bay', 'city')",
      [DEST],
    );
    await adminQuery(
      "insert into auth.users (id, email) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)",
      [PRO, "pro@ai.test", FREE, "free@ai.test", PASS, "pass@ai.test", OTHER, "other@ai.test"],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values ($1, 'pro', 'active', now(), 'test', 'd03-pro')`,
      [PRO],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at, source, source_reference)
       values ($1, 'destination', $2, 'active', now(), 'test', 'd03-pass')`,
      [PASS, DEST],
    );
    await adminQuery(
      `insert into public.hotels (id, name, slug, destination_id)
       values ($1, 'Draft Hotel', 'draft-hotel', $3),
              ($2, 'Locked Hotel', 'locked-hotel', $3)`,
      [HOTEL, HOTEL_LOCKED, DEST],
    );
    for (const userId of [PRO, FREE, PASS, OTHER]) {
      const ledger = await adminQuery<{ id: string }>(
        "select id from public.credit_ledger where user_id = $1 and reason = 'free_grant' limit 1",
        [userId],
      );
      await adminQuery(
        `insert into public.contact_unlocks (user_id, hotel_id, ledger_id, created_at)
         values ($1, $2, $3, case when $1 = $4::uuid then now() - interval '40 days' else now() end)`,
        [userId, HOTEL, ledger[0]!.id, PASS],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("charges a Pro caller once and refuses Free, a Pass, and an empty balance", async () => {
    const key = "ai_draft:d03-once";
    const first = await commitAs<{ result: unknown }>(
      { role: "authenticated", sub: PRO },
      "select public.charge_own_ai_draft($1) as result",
      [key],
    );
    expect(first.error).toBeNull();
    expect(jsonOf(first.rows[0]?.result).status).toBe("charged");
    expect(await balanceOf(PRO)).toBe(
      CREDITS_CONFIG.planMonthlyCredits.pro +
        CREDITS_CONFIG.freeWeeklyCredits -
        CREDITS_CONFIG.aiDraftCost,
    );

    const second = await queryAs<{ result: unknown }>(
      { role: "authenticated", sub: PRO },
      "select public.charge_own_ai_draft($1) as result",
      [key],
    );
    expect(jsonOf(second.rows[0]?.result).status).toBe("already_charged");
    expect(await balanceOf(PRO)).toBe(
      CREDITS_CONFIG.planMonthlyCredits.pro +
        CREDITS_CONFIG.freeWeeklyCredits -
        CREDITS_CONFIG.aiDraftCost,
    );

    const stranger = await commitAs<{ result: unknown }>(
      { role: "authenticated", sub: OTHER },
      "select public.charge_own_ai_draft($1) as result",
      ["ai_draft:other-tries-pro-key"],
    );
    expect(jsonOf(stranger.rows[0]?.result).status).toBe("forbidden");
    expect(await balanceOf(PRO)).toBe(
      CREDITS_CONFIG.planMonthlyCredits.pro +
        CREDITS_CONFIG.freeWeeklyCredits -
        CREDITS_CONFIG.aiDraftCost,
    );

    const free = await commitAs<{ result: unknown }>(
      { role: "authenticated", sub: FREE },
      "select public.charge_own_ai_draft($1) as result",
      ["ai_draft:free"],
    );
    expect(jsonOf(free.rows[0]?.result).status).toBe("forbidden");
    const freeDrafts = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.credit_ledger where user_id = $1 and reason = 'ai_draft'",
      [FREE],
    );
    expect(freeDrafts[0]!.n).toBe(0);

    const pass = await commitAs<{ result: unknown }>(
      { role: "authenticated", sub: PASS },
      "select public.charge_own_ai_draft($1) as result",
      ["ai_draft:pass"],
    );
    expect(jsonOf(pass.rows[0]?.result).status).toBe("forbidden");

    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       values ($1, $2, 'reversal', 'd03-drain')`,
      [OTHER, -1],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [OTHER]);
    const broke = await adminQuery<{ id: string }>(
      `insert into public.access_entitlements
         (user_id, access_type, status, starts_at, source, source_reference)
       values ($1, 'max', 'active', now(), 'test', 'd03-max')
       returning id`,
      [OTHER],
    );
    await adminQuery("select public.ensure_credit_grants($1)", [OTHER]);
    const granted = await balanceOf(OTHER);
    await adminQuery(
      `insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
       values ($1, $2, 'reversal', 'd03-spend-all')`,
      [OTHER, -granted],
    );
    expect(await balanceOf(OTHER)).toBe(0);
    const empty = await commitAs<{ result: unknown }>(
      { role: "authenticated", sub: OTHER },
      "select public.charge_own_ai_draft($1) as result",
      ["ai_draft:empty"],
    );
    expect(jsonOf(empty.rows[0]?.result).status).toBe("out_of_credits");
    expect(broke[0]?.id).toBeTruthy();
  });

  it("hard-stops at the monthly budget and hides another user's counts", async () => {
    const request = "d0300000-0000-4000-8000-00000000b001";
    const denied = await queryAs(
      { role: "authenticated", sub: PRO },
      "select public.prepare_ai_usage($1,$2,'claude-sonnet-5-5',$3,1000,5000000,2,100000000,1500)",
      [PRO, request, HOTEL],
    );
    expect(denied.error?.message ?? "").toMatch(/permission denied/i);

    await adminQuery(
      `insert into public.ai_usage (
         request_id, user_id, task, model, hotel_id, input_tokens, output_tokens,
         estimated_cost_micros, budget_micros, status, created_at
       ) values ($1, $2, 'compose_pitch', 'claude-sonnet-5-5', $3, 0, 0, 4900000, 4900000, 'reserved', now() - interval '1 hour')`,
      [request, PRO, HOTEL],
    );

    // The compat shim does not grant service_role USAGE on public. Hosted
    // Supabase does. The execute grant is asserted in the ACL matrix. The
    // body is run as the migration owner, the same way other service-only
    // functions are tested.
    const locked = await prepare(PRO, "d0300000-0000-4000-8000-00000000b002", HOTEL_LOCKED, 1000, 5_000_000);
    expect(locked.status).toBe("not_unlocked");
    const over = await prepare(PRO, "d0300000-0000-4000-8000-00000000b003", HOTEL, 200_000, 5_000_000);
    expect(over.status).toBe("budget");

    const recent = "d0300000-0000-4000-8000-00000000b004";
    const first = await prepare(PRO, recent, HOTEL, 1000, 20_000_000);
    expect(first.status).toBe("reserved");
    expect(first.weight).toBe(1);
    const again = await prepare(PRO, "d0300000-0000-4000-8000-00000000b005", HOTEL, 1000, 20_000_000);
    expect(again.status).toBe("rate_limited");

    const columns = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'ai_usage'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain("prompt");
    expect(names).not.toContain("body");
    expect(names).not.toContain("plain_text");

    const hiddenId = "d0300000-0000-4000-8000-00000000b099";
    await adminQuery(
      `insert into public.ai_usage (
         request_id, user_id, task, model, hotel_id, input_tokens, output_tokens,
         estimated_cost_micros, budget_micros, status, created_at
       ) values ($1, $2, 'compose_pitch', 'claude-sonnet-5-5', $3, 0, 0, 1, 1, 'reserved', now() - interval '1 hour')`,
      [hiddenId, OTHER, HOTEL],
    );

    const seen = await queryAs(
      { role: "authenticated", sub: FREE },
      "select request_id from public.ai_usage",
    );
    expect(seen.error).toBeNull();
    expect(seen.rows).toEqual([]);

    const own = await queryAs(
      { role: "authenticated", sub: PRO },
      "select request_id from public.ai_usage",
    );
    expect(own.rows.map((row) => String((row as { request_id: string }).request_id))).toContain(
      request,
    );
    expect(own.rows.map((row) => String((row as { request_id: string }).request_id))).toContain(
      recent,
    );
    expect(JSON.stringify(own.rows)).not.toContain(hiddenId);
  });

  it("weights the first draft, leaves three regenerations free, and stops the next user when the pool is spent", async () => {
    await adminQuery(
      `insert into public.ai_usage (
         request_id, user_id, task, model, hotel_id, input_tokens, output_tokens,
         estimated_cost_micros, budget_micros, status, created_at
       )
       select gen_random_uuid(), $1, 'compose_pitch', 'claude-sonnet-5-5', $2,
              1, 1, 0, 0, 'completed', now() - interval '2 hours'
         from generate_series(1, 2)`,
      [PASS, HOTEL],
    );
    await adminQuery(
      `insert into public.ai_usage (
         request_id, user_id, task, model, hotel_id, input_tokens, output_tokens,
         estimated_cost_micros, budget_micros, status, created_at
       )
       select gen_random_uuid(), $1, 'compose_pitch', 'claude-sonnet-5-5', $2,
              1, 1, 0, 0, 'completed', now() - interval '2 hours'
         from generate_series(1, 5)`,
      [FREE, HOTEL],
    );

    const freeRegen = await prepare(PASS, "d0300000-0000-4000-8000-00000000c001", HOTEL, 1000, 5_000_000);
    expect(freeRegen.status).toBe("reserved");
    expect(freeRegen.weight).toBe(0);
    const flags = await adminQuery<{ signal: string }>(
      "select signal from private.abuse_flags where user_id = $1",
      [PASS],
    );
    expect(flags.map((row) => row.signal)).toContain("generation_without_recent_unlock");
    const hidden = await queryAs(
      { role: "authenticated", sub: PRO },
      "select signal from public.read_admin_abuse_flags(10)",
    );
    expect(hidden.error).toBeNull();
    expect(hidden.rows).toEqual([]);
    const table = await queryAs({ role: "authenticated", sub: PRO }, "select * from private.abuse_flags");
    expect(table.error?.message ?? "").toMatch(/permission denied/i);

    const weighted = "d0300000-0000-4000-8000-00000000c002";
    const heavy = await prepare(FREE, weighted, HOTEL, 1000, 5_000_000, 2);
    expect(heavy.status).toBe("reserved");
    expect(heavy.weight).toBe(2);
    await adminQuery(
      "select public.finish_ai_usage($1,$2,'claude-sonnet-5-5',10,5,1000,'completed',1,1500)",
      [FREE, weighted],
    );
    const ratio = await adminQuery<{ signal: string }>(
      "select signal from private.abuse_flags where user_id = $1 and signal = 'high_regen_send_ratio'",
      [FREE],
    );
    expect(ratio).toHaveLength(1);
    const alert = await adminQuery<{ level: string }>(
      "select level from private.ai_pool_alerts where level = 'exhausted'",
    );
    expect(alert.length).toBeGreaterThan(0);

    const still = await prepare(OTHER, "d0300000-0000-4000-8000-00000000c003", HOTEL, 1000, 5_000_000, 2, 1, 1500);
    expect(still.status).toBe("pool");
    const held = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.ai_usage where request_id = $1",
      ["d0300000-0000-4000-8000-00000000c003"],
    );
    expect(held[0]!.n).toBe(0);

    await adminQuery("update public.users set role = 'admin' where id = $1", [FREE]);
    const visible = await queryAs<{ signal: string }>(
      { role: "authenticated", sub: FREE },
      "select signal from public.read_admin_abuse_flags(20)",
    );
    expect(visible.error).toBeNull();
    expect(visible.rows.map((row) => row.signal)).toContain("generation_without_recent_unlock");
    const creatorBudget = await queryAs(
      { role: "authenticated", sub: OTHER },
      "select public.read_own_ai_budget() as result",
    );
    expect(jsonOf(creatorBudget.rows[0]?.result).result).toBe("ok");
    const foreign = await queryAs(
      { role: "authenticated", sub: PRO },
      "select public.read_own_ai_budget() as result",
    );
    expect(JSON.stringify(foreign.rows)).not.toContain(OTHER);
  });

  it("pauses the account after ten generations in a minute, and only an admin clears it", async () => {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    await adminQuery(
      `insert into public.ai_usage (
         request_id, user_id, task, model, hotel_id, input_tokens, output_tokens,
         estimated_cost_micros, budget_micros, status, created_at
       )
       select gen_random_uuid(), $1, 'compose_pitch', 'claude-sonnet-5-5', $2,
              0, 0, 1, 1, 'reserved', now() - interval '20 seconds'
         from generate_series(1, 10)`,
      [OTHER, HOTEL],
    );
    const paused = await prepare(OTHER, "d0300000-0000-4000-8000-00000000d001", HOTEL, 1000, 5_000_000);
    expect(paused.status).toBe("paused");
    const forbidden = await commitAs<{ result: unknown }>(
      { role: "authenticated", sub: PRO },
      "select public.admin_unpause_account($1::uuid) as result",
      [OTHER],
    );
    expect(jsonOf(forbidden.rows[0]?.result).result).toBe("forbidden");
    await adminQuery("update public.users set role = 'editor' where id = $1", [FREE]);
    const editor = await commitAs<{ result: unknown }>(
      { role: "authenticated", sub: FREE },
      "select public.admin_unpause_account($1::uuid) as result",
      [OTHER],
    );
    expect(jsonOf(editor.rows[0]?.result).result).toBe("forbidden");
    const still = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.ai_account_pauses where user_id = $1 and unpaused_at is null",
      [OTHER],
    );
    expect(still[0]!.n).toBe(1);
    await adminQuery("update public.users set role = 'admin' where id = $1", [FREE]);
    const cleared = await commitAs<{ result: unknown }>(
      { role: "authenticated", sub: FREE },
      "select public.admin_unpause_account($1::uuid) as result",
      [OTHER],
    );
    expect(jsonOf(cleared.rows[0]?.result).result).toBe("ok");
    const open = await adminQuery<{ n: number }>(
      "select count(*)::int as n from private.ai_account_pauses where user_id = $1 and unpaused_at is null",
      [OTHER],
    );
    expect(open[0]!.n).toBe(0);
  });

  it("returns plain text only for a message the caller selected and owns", async () => {
    const database = process.env.TEST_DATABASE_URL;
    if (!database) return;
    const client = new Client({ connectionString: database });
    await client.connect();
    try {
      const own = await connectedMailbox(client, "d03-own");
      const other = await connectedMailbox(client, "d03-other");
      const ownThread = randomProviderId("thread");
      const otherThread = randomProviderId("thread");
      const ownProvider = randomProviderId("msg");
      const otherProvider = randomProviderId("msg");
      await insertRawMessage(client, {
        mailAccountId: own.mailAccountId,
        userId: own.userId,
        sanitized: buildSanitizedMessage({
          providerMessageId: ownProvider,
          providerThreadId: ownThread,
          internalDateMs: Date.now(),
          messageHeaders: [{ name: "subject", value: "Stay next month" }],
          payload: { mimeType: "text/plain", body: { size: 15, data: "b3duLXNlY3JldC1ib2R5" } },
        }),
      });
      await insertRawMessage(client, {
        mailAccountId: other.mailAccountId,
        userId: other.userId,
        sanitized: buildSanitizedMessage({
          providerMessageId: otherProvider,
          providerThreadId: otherThread,
          internalDateMs: Date.now(),
          messageHeaders: [{ name: "subject", value: "Someone else" }],
          payload: { mimeType: "text/plain", body: { size: 17, data: "b3RoZXItc2VjcmV0LWJvZHk=" } },
        }),
      });
      await normalizeBatch(deps(client), {
        userId: own.userId,
        mailAccountId: own.mailAccountId,
        limit: 10,
      });
      await normalizeBatch(deps(client), {
        userId: other.userId,
        mailAccountId: other.mailAccountId,
        limit: 10,
      });
      const ownMessage = await normalizedMessageRow(client, own.mailAccountId, ownProvider);
      const otherMessage = await normalizedMessageRow(client, other.mailAccountId, otherProvider);

      const empty = await queryAs(
        { role: "authenticated", sub: own.userId },
        "select * from public.read_own_selected_gmail_plain($1::uuid[])",
        [[]],
      );
      expect(empty.rows).toEqual([]);

      const cross = await queryAs<{ plain_text: string }>(
        { role: "authenticated", sub: own.userId },
        "select plain_text from public.read_own_selected_gmail_plain($1::uuid[])",
        [[otherMessage.id]],
      );
      expect(cross.rows).toEqual([]);
      expect(JSON.stringify(cross.rows)).not.toContain("other-secret-body");

      const selected = await queryAs<{ plain_text: string }>(
        { role: "authenticated", sub: own.userId },
        "select plain_text from public.read_own_selected_gmail_plain($1::uuid[])",
        [[ownMessage.id, otherMessage.id]],
      );
      expect(selected.rows.map((row) => row.plain_text).join(" ")).toContain("own-secret-body");
      expect(JSON.stringify(selected.rows)).not.toContain("other-secret-body");

      const subjects = await queryAs<{ subject: string }>(
        { role: "authenticated", sub: own.userId },
        "select subject from public.list_own_mail_subjects(8)",
      );
      const listed = subjects.rows.map((row) => row.subject).join(" ");
      expect(listed).toContain("Stay next month");
      expect(listed).not.toContain("Someone else");
      expect(JSON.stringify(subjects.rows)).not.toContain("own-secret-body");
    } finally {
      await client.end();
    }
  });

  it("caps the weighted finish charge and refuses a free regeneration once the budget is spent", async () => {
    const userId = "d0300000-0000-4000-8000-0000000000a5";
    const hotelId = "d0300000-0000-4000-8000-0000000000b3";
    const requestId = "d0300000-0000-4000-8000-00000000c010";
    await adminQuery(
      "insert into auth.users (id, email) values ($1, 'd03-cap@example.invalid')",
      [userId],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, 'Cap Hotel', 'cap-hotel', $2)",
      [hotelId, DEST],
    );
    const ledger = await adminQuery<{ id: string }>(
      "select id from public.credit_ledger where user_id = $1 and reason = 'free_grant' limit 1",
      [userId],
    );
    await adminQuery(
      "insert into public.contact_unlocks (user_id, hotel_id, ledger_id) values ($1, $2, $3)",
      [userId, hotelId, ledger[0]!.id],
    );

    const reserved = await prepare(userId, requestId, hotelId, 1000, 1000);
    expect(reserved).toMatchObject({ status: "reserved", weight: 1 });
    await adminQuery(
      "select public.finish_ai_usage($1,$2,'claude-sonnet-5-5',10,5,8000,'completed',0,1500)",
      [userId, requestId],
    );
    const finished = await adminQuery<{ estimated_cost_micros: string; budget_micros: string }>(
      `select estimated_cost_micros::text, budget_micros::text
         from public.ai_usage
        where request_id = $1 and status = 'completed'`,
      [requestId],
    );
    expect(finished[0]).toEqual({ estimated_cost_micros: "8000", budget_micros: "1000" });

    await new Promise((resolve) => setTimeout(resolve, 3500));
    const blocked = await prepare(userId, "d0300000-0000-4000-8000-00000000c011", hotelId, 1000, 1000);
    expect(blocked.status).toBe("budget");

    await expect(adminQuery("delete from public.hotels where id = $1", [hotelId])).rejects.toThrow(
      /foreign key|ai_usage/i,
    );
  });

  it("reserves nothing when the pool floor is missing or global spend has reached the pool", async () => {
    const userId = "d0300000-0000-4000-8000-0000000000a6";
    const missingId = "d0300000-0000-4000-8000-00000000c020";
    const fullId = "d0300000-0000-4000-8000-00000000c021";
    await adminQuery(
      "insert into auth.users (id, email) values ($1, 'd03-pool@example.invalid')",
      [userId],
    );
    const ledger = await adminQuery<{ id: string }>(
      "select id from public.credit_ledger where user_id = $1 and reason = 'free_grant' limit 1",
      [userId],
    );
    await adminQuery(
      "insert into public.contact_unlocks (user_id, hotel_id, ledger_id) values ($1, $2, $3)",
      [userId, HOTEL, ledger[0]!.id],
    );

    const missing = await prepare(userId, missingId, HOTEL, 1000, 5_000_000, 2, 0, 1500);
    expect(missing.status).toBe("pool");
    const full = await prepare(userId, fullId, HOTEL, 1000, 5_000_000, 2, 1, 1500);
    expect(full.status).toBe("pool");
    const rows = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.ai_usage where request_id in ($1, $2)",
      [missingId, fullId],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
