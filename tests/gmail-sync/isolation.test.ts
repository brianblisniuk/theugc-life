import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { queryAs, setupDatabase } from "../db/harness";
import { startDeletion } from "../gmail-import/harness";

import { completedImport, cursorOf, mailbox, rpc } from "./harness";

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

const TABLES = [
  "gmail_sync_cursors",
  "gmail_sync_runs",
  "gmail_sync_threads",
  "gmail_sync_thread_coverage",
] as const;

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

async function seeded(label: string) {
  const mail = await mailbox(client, label);
  const imported = await completedImport(client, mail);
  const run = await client.query<{ id: string }>(
    `insert into private.gmail_sync_runs
       (user_id, mail_account_id, status, mode, window_start_at, window_end_at,
        history_id_latest, enumeration_complete, known_threads_enqueued, completed_at)
     values ($1, $2, 'completed', 'history_list', $3::timestamptz, $3::timestamptz + interval '1 hour',
             '1', true, true, now())
     returning id`,
    [mail.userId, mail.mailAccountId, imported.horizon],
  );
  await client.query(
    `insert into private.gmail_sync_cursors
       (mail_account_id, user_id, history_id, horizon_end_at, next_sync_at)
     values ($1, $2, '1', $3, now() + interval '15 minutes')`,
    [mail.mailAccountId, mail.userId, imported.horizon],
  );
  await client.query(
    `insert into private.gmail_sync_threads
       (run_id, user_id, mail_account_id, provider_thread_id, status, completed_at)
     values ($1, $2, $3, 't', 'complete', now())`,
    [run.rows[0]!.id, mail.userId, mail.mailAccountId],
  );
  await client.query(
    `insert into private.gmail_sync_thread_coverage
       (mail_account_id, user_id, provider_thread_id, run_id, observed_through_at)
     values ($1, $2, 't', $3, $4)`,
    [mail.mailAccountId, mail.userId, run.rows[0]!.id, imported.horizon],
  );
  return mail;
}

d("B08 tenant isolation and deletion", () => {
  it("User A cannot read or write User B's sync rows, and anon cannot either", async () => {
    const a = await seeded("b08-iso-a");
    const b = await seeded("b08-iso-b");

    for (const [actor, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const table of TABLES) {
        const selected = await queryAs(
          { role: "authenticated", sub: actor.userId },
          `select 1 from private.${table} where user_id = $1`,
          [other.userId],
        );
        expect(selected.error, `${table} select`).toBeNull();
        expect(selected.rows, table).toHaveLength(0);

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

      const status = await queryAs(
        { role: "authenticated", sub: actor.userId },
        "select public.gmail_incremental_sync_status($1, $2)",
        [other.userId, other.mailAccountId],
      );
      expect(status.error?.code).toBe("42501");
    }

    for (const table of TABLES) {
      const own = await queryAs<{ n: number }>(
        { role: "authenticated", sub: a.userId },
        `select count(*)::int as n from private.${table}`,
      );
      expect(own.rows[0]!.n, table).toBeGreaterThan(0);
      const anon = await queryAs({ role: "anon" }, `select 1 from private.${table}`);
      expect(anon.error?.code, table).toBe("42501");
    }

    const crossed = await rpc(client).rpc("gmail_incremental_sync_status", {
      p_user_id: a.userId,
      p_mail_account_id: b.mailAccountId,
    });
    expect((crossed.data as { result: string }).result).toBe("not_found");

    const anonRpc = await queryAs(
      { role: "anon" },
      "select public.gmail_incremental_sync_list_due(1)",
    );
    expect(anonRpc.error?.code).toBe("42501");
  });

  it("refuses deleted while sync rows remain, and allows it after purge", async () => {
    const mail = await seeded("b08-purge");
    const requestId = await startDeletion(client, mail.mailAccountId, mail.userId);
    const historical = await rpc(client).rpc("gmail_historical_import_purge_for_deletion", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_deletion_request_id: requestId,
    });
    expect((historical.data as { result: string }).result).toBe("ok");

    await client.query("begin");
    await client.query(
      "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
      [requestId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [mail.mailAccountId],
    );
    await expect(client.query("commit")).rejects.toThrow(/while B08 sync state remains/);
    await client.query("rollback").catch(() => undefined);

    const purge = await rpc(client).rpc("gmail_incremental_sync_purge_for_deletion", {
      p_user_id: mail.userId,
      p_mail_account_id: mail.mailAccountId,
      p_deletion_request_id: requestId,
    });
    expect((purge.data as { result: string }).result).toBe("ok");
    await client.query("begin");
    await client.query(
      "update public.mail_account_deletion_requests set status = 'completed', completed_at = now() where id = $1",
      [requestId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [mail.mailAccountId],
    );
    await client.query("commit");
    const left = await client.query<{ n: number }>(
      "select count(*)::int as n from private.gmail_sync_cursors where mail_account_id = $1",
      [mail.mailAccountId],
    );
    expect(left.rows[0]!.n).toBe(0);
    await expect(cursorOf(client, mail.mailAccountId)).resolves.toBeUndefined();
  });
});
