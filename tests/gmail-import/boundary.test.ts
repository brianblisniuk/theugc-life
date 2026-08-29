import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { B02_REQUESTED_SCOPES } from "@/lib/gmail/contract";
import { B03_ACQUISITION_STRATEGY } from "@/lib/gmail/import/contract";

import {
  connectedMailbox,
  rawMessages,
  rpc,
  runRow,
  setConnectionState,
  stateOf,
  withdrawConsent,
} from "./harness";

/**
 * B03 §28–29: the private boundary, and what it takes to start a run.
 *
 * B01 promised that Gmail content would be server-side only, unreachable by any
 * client role and deletion-addressable. B03 is the first layer that actually
 * holds content, so this is where that promise stops being about an empty
 * schema.
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

d("B03 private boundary (0037)", () => {
  const B03_TABLES = [
    "gmail_historical_import_runs",
    "gmail_historical_import_threads",
    "gmail_raw_messages",
  ];

  it("1-4. no client role — service_role included — reaches the B03 tables", async () => {
    const roles = ["anon", "authenticated", "service_role"];

    // The schema itself is the boundary. service_role is BYPASSRLS, so RLS
    // could never have protected message content from it; withholding USAGE is
    // what does, and 0036 established that for credentials.
    const usage = await client.query(
      `select r.rolname, has_schema_privilege(r.rolname, 'private', 'USAGE') as usage
         from (values ('anon'),('authenticated'),('service_role')) as r(rolname)`,
    );
    for (const row of usage.rows) expect([row.rolname, row.usage]).toEqual([row.rolname, false]);

    const privileges = await client.query(
      `select c.relname, r.rolname,
              has_table_privilege(r.rolname, c.oid, 'SELECT') as sel,
              has_table_privilege(r.rolname, c.oid, 'INSERT') as ins,
              has_table_privilege(r.rolname, c.oid, 'UPDATE') as upd,
              has_table_privilege(r.rolname, c.oid, 'DELETE') as del
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
        where n.nspname = 'private' and c.relname = any($1::text[])`,
      [B03_TABLES],
    );
    expect(privileges.rows.length).toBe(B03_TABLES.length * roles.length);
    for (const row of privileges.rows) {
      expect([row.relname, row.rolname, row.sel, row.ins, row.upd, row.del]).toEqual([
        row.relname,
        row.rolname,
        false,
        false,
        false,
        false,
      ]);
    }
  });

  it("3. an admin/editor client session cannot read raw Gmail messages either", async () => {
    // There is no staff exception. An admin is a client role like any other:
    // "support can look" is exactly the access B01 said this layer would not
    // have.
    for (const role of ["anon", "authenticated", "service_role"]) {
      const probe = new Client({ connectionString: TEST_DB });
      await probe.connect();
      let refused = false;
      try {
        await probe.query("begin");
        await probe.query(`set local role ${role}`);
        await probe.query("select * from private.gmail_raw_messages limit 1");
      } catch {
        refused = true;
      } finally {
        await probe.query("rollback").catch(() => undefined);
        await probe.end();
      }
      expect(refused, `${role} must not read raw Gmail messages`).toBe(true);
    }
  });

  it("5-6. the B03 RPCs are definer-rights and pin their search_path", async () => {
    const res = await client.query(`
      select p.proname, p.prosecdef, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'gmail\\_historical\\_import\\_%'
    `);
    expect(res.rows.length).toBe(12);
    for (const row of res.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(
        (row.proconfig ?? []).some((c: string) => c.startsWith("search_path=")),
        row.proname,
      ).toBe(true);
    }
  });

  it("7. only service_role may execute them", async () => {
    const functions = [
      "public.gmail_historical_import_start(uuid,uuid,timestamptz)",
      "public.gmail_historical_import_claim_step(uuid,uuid,integer)",
      "public.gmail_historical_import_commit_page(uuid,uuid,uuid,bigint,text,text,text[],integer,integer)",
      "public.gmail_historical_import_commit_thread(uuid,uuid,uuid,bigint,text,jsonb,integer,integer,integer)",
      "public.gmail_historical_import_record_thread_gone(uuid,uuid,uuid,bigint,text,integer)",
      "public.gmail_historical_import_record_retry(uuid,uuid,uuid,bigint,text,text,integer,integer,integer)",
      "public.gmail_historical_import_pause(uuid,uuid,text)",
      "public.gmail_historical_import_cancel_connection_stopped(uuid,uuid,text)",
      "public.gmail_historical_import_resume(uuid,uuid)",
      "public.gmail_historical_import_commit_completion(uuid,uuid,uuid,bigint)",
      "public.gmail_historical_import_status(uuid,uuid)",
      "public.gmail_historical_import_purge_for_deletion(uuid,uuid,uuid)",
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
  });

  it("B03 stores no provider credential, and nothing it stores is a Google secret", async () => {
    const res = await client.query(
      `select c.relname, a.attname
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relkind = 'r'
          and c.relname = any($1::text[])
          and a.attnum > 0 and not a.attisdropped`,
      [B03_TABLES],
    );
    const columns = res.rows.map((r) => `${r.relname}.${r.attname}`);

    // B02 owns credentials; B03 never copies one. There is nowhere here that
    // could hold a refresh or access token even by accident.
    for (const forbidden of ["refresh_token", "access_token", "id_token", "code_verifier"]) {
      expect(columns.filter((c) => c.includes(forbidden))).toEqual([]);
    }

    // Two token-shaped columns exist and NEITHER is a Google secret:
    //   `enumeration_page_token` is an opaque Gmail pagination cursor — it
    //   authorizes nothing, is meaningless outside a listing, and must be stored
    //   as-is because resuming means handing it back;
    //   `lease_token` is generated by this database to identify a worker's claim
    //   on a step, and never leaves the server.
    const tokenColumns = columns.filter((c) => /token/i.test(c)).sort();
    expect(tokenColumns).toEqual([
      "gmail_historical_import_runs.enumeration_page_token",
      "gmail_historical_import_runs.lease_token",
    ]);

    // And nothing that could HOLD an attachment. The two columns whose names
    // mention attachments are `integer` counters of what was omitted — a count
    // cannot carry bytes, and measuring the gap is the point (§6).
    const columnNames = res.rows.map((r) => r.attname as string);
    for (const forbidden of ["attachment_id", "attachment_data", "filename", "raw", "snippet"]) {
      expect(columnNames.filter((c) => c.includes(forbidden))).toEqual([]);
    }
    const counters = await client.query(
      `select a.attname, format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname = any($1::text[])
          and a.attnum > 0 and not a.attisdropped
          and a.attname ~* 'attachment|omitted'`,
      [B03_TABLES],
    );
    expect(counters.rows.length).toBeGreaterThan(0);
    for (const row of counters.rows) {
      expect([row.attname, row.type]).toEqual([row.attname, "integer"]);
    }
  });

  it("8. a stranger cannot start, work or purge another user's mailbox", async () => {
    const owner = await connectedMailbox(client, "b03-owner");
    const stranger = await connectedMailbox(client, "b03-stranger");
    const db = rpc(client);

    // The owner is part of the LOOKUP in every surface, so a stranger's call
    // does not find a row to refuse — it finds nothing at all.
    const started = await db.rpc("gmail_historical_import_start", {
      p_user_id: stranger.userId,
      p_mail_account_id: owner.mailAccountId,
      p_window_start_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect((started.data as { result: string }).result).toBe("not_found");

    const mine = await db.rpc("gmail_historical_import_start", {
      p_user_id: owner.userId,
      p_mail_account_id: owner.mailAccountId,
      p_window_start_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const runId = (mine.data as { run_id: string }).run_id;

    for (const [fn, args] of [
      ["gmail_historical_import_claim_step", { p_run_id: runId, p_lease_seconds: 60 }],
      ["gmail_historical_import_status", { p_run_id: runId }],
      ["gmail_historical_import_resume", { p_run_id: runId }],
    ] as const) {
      const res = await db.rpc(fn, { p_user_id: stranger.userId, ...args });
      expect([fn, (res.data as { result: string }).result]).toEqual([fn, "not_found"]);
    }

    const purge = await db.rpc("gmail_historical_import_purge_for_deletion", {
      p_user_id: stranger.userId,
      p_mail_account_id: owner.mailAccountId,
      p_deletion_request_id: runId,
    });
    expect((purge.data as { result: string }).result).toBe("not_found");
  });

  it("9. full user deletion cascades every B03 row", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-cascade");
    const db = rpc(client);
    const started = await db.rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const runId = (started.data as { run_id: string }).run_id;

    await client.query(
      `insert into private.gmail_historical_import_threads
         (run_id, user_id, mail_account_id, provider_thread_id)
       values ($1, $2, $3, 't-cascade')`,
      [runId, userId, mailAccountId],
    );
    await client.query(
      `insert into private.gmail_raw_messages
         (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
          sanitized_payload, payload_sha256)
       values ($1, $2, 'm-cascade', 't-cascade', now(), '{}'::jsonb, $3)`,
      [mailAccountId, userId, "c".repeat(64)],
    );

    await client.query("delete from public.users where id = $1", [userId]);

    for (const table of B03_TABLES) {
      const res = await client.query(
        `select count(*)::int as n from private.${table} where user_id = $1`,
        [userId],
      );
      expect([table, res.rows[0].n]).toEqual([table, 0]);
    }
  });

  it("the DATABASE is the final authority for raw-message identity", async () => {
    // The commit function also dedupes, but a function is a habit and a
    // constraint is a guarantee: if some future writer reaches this table by
    // another path, PostgreSQL is what still refuses a second copy of one
    // message. Identity is (mailbox, provider message id) — not (run, message),
    // because the same Gmail message seen in ten imports is one message.
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-unique");
    const insert = () =>
      client.query(
        `insert into private.gmail_raw_messages
           (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
            sanitized_payload, payload_sha256)
         values ($1, $2, 'dup-message', 't-dup', now(), '{}'::jsonb, $3)`,
        [mailAccountId, userId, "f".repeat(64)],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key value|gmail_raw_messages_pkey/);

    const rows = await rawMessages(client, mailAccountId);
    expect(rows).toHaveLength(1);
  });

  it("10. B03 provenance cannot disagree with B01 mailbox ownership", async () => {
    const a = await connectedMailbox(client, "b03-prov-a");
    const b = await connectedMailbox(client, "b03-prov-b");

    // The composite FK is what makes this unrepresentable rather than merely
    // discouraged: a raw message names (mailbox, owner) as ONE fact.
    await expect(
      client.query(
        `insert into private.gmail_raw_messages
           (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
            sanitized_payload, payload_sha256)
         values ($1, $2, 'm-x', 't-x', now(), '{}'::jsonb, $3)`,
        [a.mailAccountId, b.userId, "d".repeat(64)],
      ),
    ).rejects.toThrow();
  });
});

d("B03 run creation (0037)", () => {
  const windowStart = () => new Date(Date.now() - 30 * 86_400_000).toISOString();

  it("11. only a connected mailbox may start a run", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-start-state");
    const db = rpc(client);
    await setConnectionState(client, mailAccountId, "disconnected");

    const res = await db.rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    expect((res.data as { result: string }).result).toBe("not_connected");
  });

  it("12. exact-scope private-processing consent is required", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-start-consent");
    const db = rpc(client);

    // A WITHDRAWN consent is refused. B01's consent dominance means the
    // withdrawal also moves the mailbox out of `connected` — a `connected` row
    // with no granted consent cannot commit — so the refusal B03 actually
    // observes is `not_connected`, and the state name carries the reason.
    await withdrawConsent(client, mailAccountId, userId);
    expect(await stateOf(client, mailAccountId)).toBe("consent_required");
    const withdrawn = await db.rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    expect((withdrawn.data as { result: string }).result).toBe("not_connected");

    // AND A SNAPSHOT THAT NO LONGER MATCHES IS UNREACHABLE, not merely refused.
    // B03 keeps a `consent_scope_changed` branch as defence in depth, but B01's
    // deferred invariant means a `connected` mailbox whose granted scopes have
    // outgrown its consent cannot be committed at all: widening what Google
    // permits is not itself a decision by the human about what we may do, so the
    // database demands a NEW receipt rather than letting the two drift.
    const other = await connectedMailbox(client, "b03-start-consent-2");
    await expect(
      client.query("update public.mail_accounts set granted_scopes = $2 where id = $1", [
        other.mailAccountId,
        [...B02_REQUESTED_SCOPES, "https://www.googleapis.com/auth/gmail.send"],
      ]),
    ).rejects.toThrow(/record a NEW consent receipt for the current scope set/);
  });

  it("13. gmail.readonly is required — and B01 makes a mailbox without it unreachable", async () => {
    // B03 keeps a `missing_read_scope` branch as a fail-closed backstop, and it
    // is deliberately unreachable from `connected`: B01's own CHECK refuses that
    // combination, because "we may write to this mailbox and may not read it" is
    // not a Gmail connection in this product's sense. Asserting the constraint
    // is the honest test — asserting the branch would require manufacturing a
    // state the database does not permit.
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-start-scope");
    await expect(
      client.query("update public.mail_accounts set granted_scopes = $2 where id = $1", [
        mailAccountId,
        ["openid", "https://www.googleapis.com/auth/userinfo.email"],
      ]),
    ).rejects.toThrow(/mail_accounts_connected_requires_read/);

    // And with the scope present, the same mailbox starts normally.
    const ok = await rpc(client).rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    expect((ok.data as { result: string }).result).toBe("ok");
  });

  it("14-15. the window is start<end, database-owned at the end, and immutable", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-window");
    const db = rpc(client);

    const future = await db.rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect((future.data as { result: string }).result).toBe("invalid_window");

    const started = await db.rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    const runId = (started.data as { run_id: string }).run_id;
    const before = await runRow(client, runId);
    expect(new Date(before.window_start_at).getTime()).toBeLessThan(
      new Date(before.window_end_at).getTime(),
    );

    // A run that could be widened after the fact would make every resumption a
    // different operation.
    await expect(
      client.query(
        "update private.gmail_historical_import_runs set window_end_at = now() + interval '1 day' where id = $1",
        [runId],
      ),
    ).rejects.toThrow(/cannot change its owner, mailbox, window or acquisition strategy/);

    await expect(
      client.query(
        "update private.gmail_historical_import_runs set window_start_at = now() - interval '900 days' where id = $1",
        [runId],
      ),
    ).rejects.toThrow(/cannot change its owner, mailbox, window/);
  });

  it("16-17. the acquisition strategy is fixed and no Gmail query can be stored", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-strategy");
    const started = await rpc(client).rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    const runId = (started.data as { run_id: string }).run_id;
    const row = await runRow(client, runId);
    expect(row.acquisition_strategy).toBe(B03_ACQUISITION_STRATEGY);

    await expect(
      client.query(
        "update private.gmail_historical_import_runs set acquisition_strategy = 'whole_inbox' where id = $1",
        [runId],
      ),
    ).rejects.toThrow();

    // THERE IS NOWHERE TO PUT ONE. A Gmail `q` is a capability to ask for
    // anything in the mailbox; the schema simply has no column that could carry
    // a caller-supplied one into the provider request.
    const columns = await client.query(
      `select a.attname from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname = 'gmail_historical_import_runs'
          and a.attnum > 0 and not a.attisdropped`,
    );
    const names = columns.rows.map((r) => r.attname as string);
    for (const forbidden of ["query", "q", "search", "gmail_query", "filter"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("18-19. one active run per mailbox; a finished one does not block the next", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-one-active");
    const db = rpc(client);

    const first = await db.rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    const runId = (first.data as { run_id: string }).run_id;

    const second = await db.rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    expect((second.data as { result: string }).result).toBe("run_already_active");

    await client.query(
      `update private.gmail_historical_import_runs
          set status = 'completed', phase = 'finished', completed_at = now() where id = $1`,
      [runId],
    );

    const third = await db.rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    expect((third.data as { result: string }).result).toBe("ok");
  });

  it("20. the migration created no mailbox, no run and no message", async () => {
    // A migration that connected a mailbox or inferred a consent would be making
    // a decision only a human may make.
    const runs = await client.query(
      "select count(*)::int as n from private.gmail_historical_import_runs where created_at < now() - interval '1 hour'",
    );
    expect(runs.rows[0].n).toBe(0);

    const orphaned = await client.query(
      `select count(*)::int as n from private.gmail_raw_messages r
         where not exists (select 1 from public.mail_accounts m where m.id = r.mail_account_id)`,
    );
    expect(orphaned.rows[0].n).toBe(0);
  });

  it("a started run holds no content, only counts", async () => {
    const { userId, mailAccountId } = await connectedMailbox(client, "b03-empty-start");
    const started = await rpc(client).rpc("gmail_historical_import_start", {
      p_user_id: userId,
      p_mail_account_id: mailAccountId,
      p_window_start_at: windowStart(),
    });
    expect((started.data as { result: string }).result).toBe("ok");
    expect(await rawMessages(client, mailAccountId)).toHaveLength(0);
  });
});
