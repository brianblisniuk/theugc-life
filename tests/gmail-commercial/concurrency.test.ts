import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  COMMERCIAL_RULE_VERSION,
  COMMERCIAL_SCHEMA_VERSION,
  COMMERCIAL_TRANSFORM_VERSION,
} from "@/lib/gmail/commercial/contract";
import { interpretOneThread } from "@/lib/gmail/commercial/service";
import { setupDatabase } from "../db/harness";
import { asCreator, commercialDeps, interpretedThread } from "./harness";

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);
const ENGAGED = "We'd love to collaborate. Are your October dates still free?";

let client: Client;
const openSessions: Client[] = [];

beforeAll(async () => {
  if (!TEST_DB) return;
  await setupDatabase();
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterEach(async () => {
  while (openSessions.length > 0) {
    const session = openSessions.pop()!;
    await session.end().catch(() => undefined);
  }
});

afterAll(async () => {
  if (client) await client.end();
});

async function session(): Promise<Client> {
  const next = new Client({ connectionString: TEST_DB });
  await next.connect();
  openSessions.push(next);
  return next;
}

async function waitUntilBlocked(pid: number, timeoutMs = 20_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.query("select pg_blocking_pids($1) as blockers", [pid]);
    const blockers: number[] = res.rows[0].blockers ?? [];
    if (blockers.length > 0) return blockers;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

d("B07 concurrency and stale human writes", () => {
  it("a machine rerun blocked on the account lock does not delete the creator event", async () => {
    const fixture = await interpretedThread(client, "b07-race", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");
    const evidence = await deps.db.rpc("gmail_commercial_get_thread_evidence", {
      p_user_id: fixture.userId,
      p_mail_account_id: fixture.mailAccountId,
      p_normalized_thread_id: fixture.normalizedThreadId,
      p_schema_version: COMMERCIAL_SCHEMA_VERSION,
      p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
      p_rule_version: COMMERCIAL_RULE_VERSION,
    });
    const digest = (
      evidence.data as {
        input_digest: string;
        messages: Array<{ provider_message_id: string; eligible: boolean }>;
      }
    ).input_digest;
    const messages = (
      evidence.data as { messages: Array<{ provider_message_id: string; eligible: boolean }> }
    ).messages
      .filter((message) => message.eligible)
      .map((message) => ({
        provider_message_id: message.provider_message_id,
        disposition: "positive",
        signals: ["interest", "request_information"],
        evidence_strength: "moderate",
      }));

    const t1 = await session();
    const t2 = await session();
    await t1.query("begin");
    const t1Pid = Number((await t1.query("select pg_backend_pid() as pid")).rows[0].pid);
    await t1.query("select 1 from public.mail_accounts where id = $1 for update", [
      fixture.mailAccountId,
    ]);
    await t1.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: fixture.userId, role: "authenticated" }),
    ]);
    const decision = await t1.query(
      `select public.gmail_commercial_record_creator_decision(
         $1, 'disposition', 'set', $2, null, null, 'negative', null, null, null, null
       ) as value`,
      [fixture.mailAccountId, fixture.replyId],
    );
    expect((decision.rows[0].value as { result: string }).result).toBe("ok");

    await t2.query("begin");
    const t2Pid = Number((await t2.query("select pg_backend_pid() as pid")).rows[0].pid);
    const commitPromise = t2.query(
      `select public.gmail_commercial_commit_interpretation(
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb
       ) as value`,
      [
        fixture.userId,
        fixture.mailAccountId,
        fixture.normalizedThreadId,
        COMMERCIAL_SCHEMA_VERSION,
        COMMERCIAL_TRANSFORM_VERSION,
        COMMERCIAL_RULE_VERSION,
        digest,
        JSON.stringify(messages),
        JSON.stringify({
          commercial_state: "engaged",
          compensation_structure: "unknown",
          evidence_strength: "moderate",
        }),
      ],
    );
    const blockers = await waitUntilBlocked(t2Pid);
    expect(blockers).toContain(t1Pid);

    await t1.query("commit");
    const committed = await commitPromise;
    await t2.query("commit");
    expect(["ok", "already_current"]).toContain(
      (committed.rows[0].value as { result: string }).result,
    );

    const human = await client.query(
      `select disposition from private.gmail_commercial_message_decisions
        where mail_account_id = $1 and axis = 'disposition'`,
      [fixture.mailAccountId],
    );
    expect(human.rows[0].disposition).toBe("negative");
    const events = await client.query(
      "select count(*)::int as n from private.gmail_commercial_creator_decision_events where mail_account_id = $1",
      [fixture.mailAccountId],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it("a backwards event_seq cannot replace the current human projection", async () => {
    const fixture = await interpretedThread(client, "b07-stale-seq", ENGAGED);
    const deps = commercialDeps(client);
    expect(
      (
        await interpretOneThread(deps, {
          userId: fixture.userId,
          mailAccountId: fixture.mailAccountId,
          normalizedThreadId: fixture.normalizedThreadId,
        })
      ).result,
    ).toBe("ok");
    await asCreator(client, fixture.userId, () =>
      deps.db.rpc("gmail_commercial_record_creator_decision", {
        p_mail_account_id: fixture.mailAccountId,
        p_axis: "disposition",
        p_action: "set",
        p_provider_message_id: fixture.replyId,
        p_provider_thread_id: null,
        p_reply_nature: null,
        p_disposition: "ambiguous",
        p_signals: null,
        p_business_outcome: null,
        p_lost_reason: null,
        p_compensation_structure: null,
      }),
    );

    await client.query("begin");
    let code: string | undefined;
    try {
      await client.query("select set_config('b07.human_writer', 'on', true)");
      await client.query(
        `update private.gmail_commercial_message_decisions
            set current_event_seq = current_event_seq - 1
          where mail_account_id = $1`,
        [fixture.mailAccountId],
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    } finally {
      await client.query("rollback");
    }
    expect(code).toBe("40001");

    const still = await client.query(
      `select disposition, current_event_seq from private.gmail_commercial_message_decisions
        where mail_account_id = $1`,
      [fixture.mailAccountId],
    );
    expect(still.rows[0].disposition).toBe("ambiguous");
    expect(Number(still.rows[0].current_event_seq)).toBeGreaterThan(0);
  });
});
