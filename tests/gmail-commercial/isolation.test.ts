import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { interpretOneThread } from "@/lib/gmail/commercial/service";
import { queryAs, setupDatabase } from "../db/harness";
import { asCreator, commercialDeps, interpretedThread } from "./harness";

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);
const ENGAGED = "We'd love to collaborate. Are your October dates still free?";

let client: Client;

beforeAll(async () => {
  if (!TEST_DB) return;
  await setupDatabase();
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

async function ready(label: string) {
  const fixture = await interpretedThread(client, label, ENGAGED);
  const result = await interpretOneThread(commercialDeps(client), {
    userId: fixture.userId,
    mailAccountId: fixture.mailAccountId,
    normalizedThreadId: fixture.normalizedThreadId,
  });
  if (result.result !== "ok") throw new Error(JSON.stringify(result));
  return fixture;
}

const B07_TABLES = [
  "gmail_commercial_message_attempts",
  "gmail_commercial_message_current",
  "gmail_commercial_thread_attempts",
  "gmail_commercial_thread_current",
  "gmail_commercial_creator_decision_events",
  "gmail_commercial_message_decisions",
  "gmail_commercial_thread_decisions",
] as const;

d("B07 tenant isolation, both directions", () => {
  it("User A and User B cannot read, count, update, delete, or correct each other", async () => {
    const a = await ready("b07-iso-a");
    const b = await ready("b07-iso-b");
    for (const owner of [a, b]) {
      const disposition = await asCreator(client, owner.userId, () =>
        commercialDeps(client).db.rpc("gmail_commercial_record_creator_decision", {
          p_mail_account_id: owner.mailAccountId,
          p_axis: "disposition",
          p_action: "set",
          p_provider_message_id: owner.replyId,
          p_provider_thread_id: null,
          p_reply_nature: null,
          p_disposition: "mixed",
          p_signals: null,
          p_business_outcome: null,
          p_lost_reason: null,
          p_compensation_structure: null,
        }),
      );
      expect((disposition.data as { result: string }).result).toBe("ok");
      const compensation = await asCreator(client, owner.userId, () =>
        commercialDeps(client).db.rpc("gmail_commercial_record_creator_decision", {
          p_mail_account_id: owner.mailAccountId,
          p_axis: "compensation",
          p_action: "set",
          p_provider_message_id: null,
          p_provider_thread_id: owner.providerThreadId,
          p_reply_nature: null,
          p_disposition: null,
          p_signals: null,
          p_business_outcome: null,
          p_lost_reason: null,
          p_compensation_structure: "paid",
        }),
      );
      expect((compensation.data as { result: string }).result).toBe("ok");
    }

    for (const [actor, other] of [
      [b, a],
      [a, b],
    ] as const) {
      for (const table of B07_TABLES) {
        const select = await queryAs(
          { role: "authenticated", sub: actor.userId },
          `select 1 from private.${table} where user_id = $1`,
          [other.userId],
        );
        expect(select.error, `${table} select`).toBeNull();
        expect(select.rows, table).toHaveLength(0);

        const counted = await queryAs<{ n: number }>(
          { role: "authenticated", sub: actor.userId },
          `select count(*)::int as n from private.${table} where user_id = $1`,
          [other.userId],
        );
        expect(counted.error, `${table} count`).toBeNull();
        expect(counted.rows[0]!.n, table).toBe(0);

        const visible = await queryAs<{ n: number }>(
          { role: "authenticated", sub: actor.userId },
          `select count(*)::int as n from private.${table}`,
        );
        const owned = await client.query<{ n: number }>(
          `select count(*)::int as n from private.${table} where user_id = $1`,
          [actor.userId],
        );
        expect(visible.rows[0]!.n, `${table} unfiltered`).toBe(owned.rows[0]!.n);

        const updated = await queryAs(
          { role: "authenticated", sub: actor.userId },
          `update private.${table} set user_id = user_id where user_id = $1`,
          [other.userId],
        );
        expect(updated.error?.code, `${table} update`).toBe("42501");

        const deleted = await queryAs(
          { role: "authenticated", sub: actor.userId },
          `delete from private.${table} where user_id = $1`,
          [other.userId],
        );
        expect(deleted.error?.code, `${table} delete`).toBe("42501");

        const inserted = await queryAs(
          { role: "authenticated", sub: actor.userId },
          `insert into private.${table} default values`,
        );
        expect(inserted.error?.code, `${table} insert`).toBe("42501");
      }

      const read = await queryAs<{ value: { result: string } }>(
        { role: "authenticated", sub: actor.userId },
        "select public.gmail_commercial_read_thread($1, $2) as value",
        [other.mailAccountId, other.providerThreadId],
      );
      expect(read.error).toBeNull();
      expect(read.rows[0]!.value.result).toBe("not_found");

      const listed = await queryAs<{ value: { result: string; threads?: unknown[] } }>(
        { role: "authenticated", sub: actor.userId },
        "select public.gmail_commercial_list_threads($1) as value",
        [other.mailAccountId],
      );
      expect(listed.rows[0]!.value.result).toBe("not_found");

      const status = await queryAs<{ value: { result: string } }>(
        { role: "authenticated", sub: actor.userId },
        "select public.gmail_commercial_status($1) as value",
        [other.mailAccountId],
      );
      expect(status.rows[0]!.value.result).toBe("not_found");

      const correct = await queryAs<{ value: { result: string } }>(
        { role: "authenticated", sub: actor.userId },
        `select public.gmail_commercial_record_creator_decision(
           $1, 'disposition', 'set', $2, null, null, 'negative', null, null, null, null
         ) as value`,
        [other.mailAccountId, other.replyId],
      );
      expect(correct.rows[0]!.value.result).toBe("not_found");
    }

    for (const table of B07_TABLES) {
      const own = await queryAs<{ n: number }>(
        { role: "authenticated", sub: a.userId },
        `select count(*)::int as n from private.${table}`,
      );
      expect(own.rows[0]!.n, table).toBeGreaterThan(0);
    }

    const ownRead = await queryAs<{
      value: { result: string; machine: { commercial_state: string } };
    }>(
      { role: "authenticated", sub: a.userId },
      "select public.gmail_commercial_read_thread($1, $2) as value",
      [a.mailAccountId, a.providerThreadId],
    );
    expect(ownRead.rows[0]!.value.result).toBe("ok");
    expect(ownRead.rows[0]!.value.machine.commercial_state).toBe("engaged");

    const machine = await queryAs(
      { role: "authenticated", sub: a.userId },
      "select public.gmail_commercial_commit_interpretation($1,$1,$1,'x','x','x','aa', '[]'::jsonb, '{}'::jsonb)",
      [a.userId],
    );
    expect(machine.error?.code).toBe("42501");

    const anon = await queryAs(
      { role: "anon" },
      "select public.gmail_commercial_purge_for_deletion($1,$1,$1)",
      [a.userId],
    );
    expect(anon.error?.code).toBe("42501");

    const credentials = await queryAs(
      { role: "authenticated", sub: a.userId },
      "select 1 from private.gmail_oauth_credentials",
    );
    expect(credentials.error?.code).toBe("42501");

    const helper = await queryAs(
      { role: "authenticated", sub: a.userId },
      "select private.gmail_commercial_input_digest($1,$1,'a','b','c')",
      [a.mailAccountId],
    );
    expect(helper.error).not.toBeNull();
  });

  it("a projection cannot point at another account's human event", async () => {
    const a = await ready("b07-fk-a");
    const b = await ready("b07-fk-b");
    const decision = await asCreator(client, a.userId, () =>
      commercialDeps(client).db.rpc("gmail_commercial_record_creator_decision", {
        p_mail_account_id: a.mailAccountId,
        p_axis: "disposition",
        p_action: "set",
        p_provider_message_id: a.replyId,
        p_provider_thread_id: null,
        p_reply_nature: null,
        p_disposition: "mixed",
        p_signals: null,
        p_business_outcome: null,
        p_lost_reason: null,
        p_compensation_structure: null,
      }),
    );
    const eventId = (decision.data as { event_id: string }).event_id;
    await client.query("begin");
    let code: string | undefined;
    try {
      await client.query("select set_config('b07.human_writer', 'on', true)");
      await client.query(
        `insert into private.gmail_commercial_message_decisions (
           user_id, mail_account_id, provider_message_id, axis, is_cleared,
           disposition, current_event_id, current_event_seq
         ) values ($1, $2, $3, 'disposition', false, 'mixed', $4, 1)`,
        [b.userId, b.mailAccountId, b.replyId, eventId],
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    } finally {
      await client.query("rollback");
    }
    expect(code).toBe("23503");
  });
});
