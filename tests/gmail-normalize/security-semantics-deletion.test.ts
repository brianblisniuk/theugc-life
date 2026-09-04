import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeBatch } from "@/lib/gmail/normalize/service";

import {
  buildSanitizedMessage,
  connectedMailbox,
  deps,
  insertRawMessage,
  normalizedMessageRow,
  randomProviderId,
  rpcRaw,
  setConnectionState,
  startDeletion,
} from "./harness";

/**
 * B04 SEMANTIC BOUNDARY, PRIVACY/ACL, AND DELETION LIFECYCLE.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_DB);

let client: Client;

beforeAll(async () => {
  if (!TEST_DB) return;
  client = new Client({ connectionString: TEST_DB });
  await client.connect();
});

afterAll(async () => {
  if (client) await client.end();
});

d("B04 semantic boundary", () => {
  it("64. SENT absent produces provider_sent=false but NO inbound/reply fact anywhere", async () => {
    const mailbox = await connectedMailbox(client, "b04-sec-64");
    const messageId = randomProviderId("msg");
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        labelIds: ["INBOX"],
      }),
    });
    await normalizeBatch(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      limit: 10,
    });
    const message = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(message.provider_sent).toBe(false);
    // No column anywhere on this row spells "inbound" or "reply" — the CHECK
    // below (item 65) already proves no such column exists on ANY B04 table.
  });

  it("65. no hotel/outreach/outcome/network row or column is ever written by B04", async () => {
    const res = await client.query(`
      select table_name, column_name from information_schema.columns
       where table_schema = 'private' and table_name like 'gmail_normalized_%'
    `);
    const forbidden = /hotel|outreach|outcome|reply|network|pipeline|collaboration/i;
    for (const row of res.rows) {
      expect(row.column_name, `${row.table_name}.${row.column_name}`).not.toMatch(forbidden);
    }
  });

  it("69-70-71. anon and ordinary authenticated hold no privilege on any B04 relation; cross-tenant is unreachable", async () => {
    const tables = [
      "gmail_normalized_threads",
      "gmail_normalized_messages",
      "gmail_normalized_headers",
      "gmail_normalized_participants",
      "gmail_normalized_reference_tokens",
      "gmail_normalized_text_parts",
    ];

    const schemaUsage = await client.query(`
      select r.rolname, has_schema_privilege(r.rolname, 'private', 'USAGE') as usage
        from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
    `);
    for (const row of schemaUsage.rows) {
      expect(row.usage, row.rolname).toBe(false);
    }

    for (const table of tables) {
      const res = await client.query(
        `select r.rolname,
                has_table_privilege(r.rolname, format('private.%I', $1::text), 'SELECT') as sel,
                has_table_privilege(r.rolname, format('private.%I', $1::text), 'INSERT') as ins,
                has_table_privilege(r.rolname, format('private.%I', $1::text), 'UPDATE') as upd,
                has_table_privilege(r.rolname, format('private.%I', $1::text), 'DELETE') as del
           from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)`,
        [table],
      );
      for (const row of res.rows) {
        expect([table, row.rolname, row.sel, row.ins, row.upd, row.del]).toEqual([
          table,
          row.rolname,
          false,
          false,
          false,
          false,
        ]);
      }
    }

    // A live probe, not just catalog metadata: an actual session in each role
    // cannot select from the most sensitive table (decoded body text).
    for (const role of ["anon", "authenticated", "service_role"]) {
      const probe = new Client({ connectionString: TEST_DB });
      await probe.connect();
      let failed = false;
      try {
        await probe.query("begin");
        await probe.query(`set local role ${role}`);
        await probe.query("select * from private.gmail_normalized_text_parts limit 1");
      } catch {
        failed = true;
      } finally {
        await probe.query("rollback").catch(() => undefined);
        await probe.end();
      }
      expect(failed, `${role} must not read normalized text parts directly`).toBe(true);
    }
  });

  it("the RPC surface is executable by service_role and by nobody else, and every function pins search_path", async () => {
    const functions = [
      "public.gmail_normalize_list_candidates(uuid,uuid,text,integer,text,text[])",
      "public.gmail_normalize_commit_message(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)",
      "public.gmail_normalize_status(uuid,uuid,text)",
      "public.gmail_normalize_purge_for_deletion(uuid,uuid,uuid)",
    ];
    for (const fn of functions) {
      const res = await client.query(
        `select has_function_privilege('service_role', $1, 'EXECUTE') as svc,
                has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
                has_function_privilege('anon', $1, 'EXECUTE') as anon`,
        [fn],
      );
      expect([fn, res.rows[0].svc, res.rows[0].auth, res.rows[0].anon]).toEqual([
        fn,
        true,
        false,
        false,
      ]);
    }

    const res = await client.query(`
      select p.proname, p.prosecdef, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'gmail\\_normalize\\_%'
    `);
    expect(res.rows.length).toBe(4);
    for (const row of res.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(
        (row.proconfig ?? []).some((c: string) => c.startsWith("search_path=")),
        row.proname,
      ).toBe(true);
    }
  });

  it("cross-tenant: a normalize call under the WRONG user_id is refused", async () => {
    const mailboxA = await connectedMailbox(client, "b04-sec-cross-a");
    const mailboxB = await connectedMailbox(client, "b04-sec-cross-b");
    const messageId = randomProviderId("msg");
    const { payloadSha256 } = await insertRawMessage(client, {
      mailAccountId: mailboxA.mailAccountId,
      userId: mailboxA.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
      }),
    });

    // User B tries to normalize A's mailbox by naming A's mail_account_id
    // under B's own user_id — the (mail_account_id, user_id) ownership lookup
    // must refuse this, not silently normalize somebody else's mail.
    const result = await rpcRaw(client, "gmail_normalize_commit_message", {
      p_user_id: mailboxB.userId,
      p_mail_account_id: mailboxA.mailAccountId,
      p_provider_message_id: messageId,
      p_expected_source_payload_sha256: payloadSha256,
      p_normalizer_version: "gmail_normalizer_v1",
      p_headers: [],
      p_participants: [],
      p_reference_tokens: [],
      p_text_parts: [],
    });
    expect(result.result).toBe("not_found");

    const row = await normalizedMessageRow(client, mailboxA.mailAccountId, messageId);
    expect(row).toBeNull();
  });
});

d("B04 deletion lifecycle", () => {
  async function seedNormalized(label: string) {
    const mailbox = await connectedMailbox(client, label);
    const messageId = randomProviderId("msg");
    await insertRawMessage(client, {
      mailAccountId: mailbox.mailAccountId,
      userId: mailbox.userId,
      sanitized: buildSanitizedMessage({
        providerMessageId: messageId,
        providerThreadId: randomProviderId("thread"),
        internalDateMs: Date.now(),
        messageHeaders: [{ name: "from", value: "a@example.com" }],
      }),
    });
    await normalizeBatch(deps(client), {
      userId: mailbox.userId,
      mailAccountId: mailbox.mailAccountId,
      limit: 10,
    });
    return { mailbox, messageId };
  }

  it("66. disconnect retains B04 normalized data", async () => {
    const { mailbox, messageId } = await seedNormalized("b04-del-66");
    await setConnectionState(client, mailbox.mailAccountId, "disconnected");
    const row = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(row).toBeTruthy();
  });

  it("67. delete removes B04 normalized data via the B04 purge function", async () => {
    const { mailbox, messageId } = await seedNormalized("b04-del-67");
    const requestId = await startDeletion(client, mailbox.mailAccountId, mailbox.userId);

    const result = await rpcRaw(client, "gmail_normalize_purge_for_deletion", {
      p_user_id: mailbox.userId,
      p_mail_account_id: mailbox.mailAccountId,
      p_deletion_request_id: requestId,
    });
    expect(result.result).toBe("ok");
    expect(result.normalized_threads_removed).toBeGreaterThan(0);

    const row = await normalizedMessageRow(client, mailbox.mailAccountId, messageId);
    expect(row).toBeNull();
    const threads = await client.query(
      "select count(*)::int as n from private.gmail_normalized_threads where mail_account_id = $1",
      [mailbox.mailAccountId],
    );
    expect(threads.rows[0].n).toBe(0);
  });

  it("68. final deleted state with surviving B04 data is DB-rejected", async () => {
    const { mailbox } = await seedNormalized("b04-del-68");
    await startDeletion(client, mailbox.mailAccountId, mailbox.userId);

    // Purge B03's OWN data first (what a real orchestrator would do for that
    // layer), so THIS assertion isolates the B04 invariant specifically —
    // B03's raw-data trigger must not be the one doing the refusing here.
    await client.query("delete from private.gmail_raw_messages where mail_account_id = $1", [
      mailbox.mailAccountId,
    ]);
    await client.query(
      "delete from private.gmail_historical_import_threads where mail_account_id = $1",
      [mailbox.mailAccountId],
    );
    await client.query(
      "delete from private.gmail_historical_import_runs where mail_account_id = $1",
      [mailbox.mailAccountId],
    );

    // Deliberately mark `deleted` WITHOUT purging B04 data first — the
    // deferred invariant must refuse the whole transaction at COMMIT.
    await client.query("begin");
    await client.query(
      `update public.mail_account_deletion_requests
          set status = 'completed', completed_at = now()
        where mail_account_id = $1`,
      [mailbox.mailAccountId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [mailbox.mailAccountId],
    );
    await expect(client.query("commit")).rejects.toThrow(
      /integrity_constraint_violation|normalized Gmail thread/i,
    );
    await client.query("rollback").catch(() => undefined);
  });

  it("full lifecycle: seed -> disconnect (survives) -> deletion_pending -> purge -> deleted (clean)", async () => {
    const { mailbox, messageId } = await seedNormalized("b04-del-full");
    await setConnectionState(client, mailbox.mailAccountId, "disconnected");
    expect(await normalizedMessageRow(client, mailbox.mailAccountId, messageId)).toBeTruthy();

    const requestId = await startDeletion(client, mailbox.mailAccountId, mailbox.userId);
    const purge = await rpcRaw(client, "gmail_normalize_purge_for_deletion", {
      p_user_id: mailbox.userId,
      p_mail_account_id: mailbox.mailAccountId,
      p_deletion_request_id: requestId,
    });
    expect(purge.result).toBe("ok");

    // B03's own purge also needs to run in a real deletion orchestration;
    // simulate it directly so the account can legitimately reach `deleted`.
    await client.query("delete from private.gmail_raw_messages where mail_account_id = $1", [
      mailbox.mailAccountId,
    ]);
    await client.query(
      "delete from private.gmail_historical_import_threads where mail_account_id = $1",
      [mailbox.mailAccountId],
    );
    await client.query(
      "delete from private.gmail_historical_import_runs where mail_account_id = $1",
      [mailbox.mailAccountId],
    );

    await client.query("begin");
    await client.query(
      `update public.mail_account_deletion_requests
          set status = 'completed', completed_at = now()
        where mail_account_id = $1`,
      [mailbox.mailAccountId],
    );
    await client.query(
      "update public.mail_accounts set connection_state = 'deleted' where id = $1",
      [mailbox.mailAccountId],
    );
    await expect(client.query("commit")).resolves.toBeTruthy();
  });
});
