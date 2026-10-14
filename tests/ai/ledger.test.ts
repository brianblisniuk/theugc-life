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

function jsonOf(value: unknown): { status?: string } {
  if (typeof value === "string") return JSON.parse(value) as { status?: string };
  return (value ?? {}) as { status?: string };
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
      `select public.prepare_ai_usage($1,$2,'claude-sonnet-5-5',1000,1000,15,20000,10,20)`,
      [PRO, request],
    );
    expect(denied.error?.message ?? "").toMatch(/permission denied/i);

    await adminQuery(
      `insert into public.ai_usage (
         request_id, user_id, task, model, input_tokens, output_tokens,
         estimated_cost_micros, status, created_at
       ) values ($1, $2, 'compose_pitch', 'claude-sonnet-5-5', 0, 0, 1000, 'reserved', now() - interval '1 hour')`,
      [request, PRO],
    );

    // The compat shim does not grant service_role USAGE on public. Hosted
    // Supabase does. The execute grant is asserted in the ACL matrix. The
    // body is run as the migration owner, the same way other service-only
    // functions are tested.
    const over = await adminQuery<{ result: unknown }>(
      `select public.prepare_ai_usage($1,$2,'claude-sonnet-5-5',600,1500,15,20000,10,20) as result`,
      [PRO, "d0300000-0000-4000-8000-00000000b002"],
    );
    expect(jsonOf(over[0]?.result).status).toBe("budget");

    const recent = "d0300000-0000-4000-8000-00000000b003";
    const first = await adminQuery<{ result: unknown }>(
      `select public.prepare_ai_usage($1,$2,'claude-sonnet-5-5',10,5000000,15,20000,1,1) as result`,
      [OTHER, recent],
    );
    expect(jsonOf(first[0]?.result).status).toBe("reserved");
    const again = await adminQuery<{ result: unknown }>(
      `select public.prepare_ai_usage($1,$2,'claude-sonnet-5-5',10,5000000,15,20000,1,1) as result`,
      [OTHER, "d0300000-0000-4000-8000-00000000b004"],
    );
    expect(jsonOf(again[0]?.result).status).toBe("rate_limited");

    const columns = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'ai_usage'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain("prompt");
    expect(names).not.toContain("body");
    expect(names).not.toContain("plain_text");

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
    expect(JSON.stringify(own.rows)).not.toContain(recent);
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
});
