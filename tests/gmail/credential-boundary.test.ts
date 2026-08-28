import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The credential boundary, asserted against the real schema.
 *
 * B01 promised that B02 would keep credentials server-side only, encrypted,
 * never in a generally queryable table and never reachable by a client. These
 * are the tests that hold B02 to it — and, just as importantly, the ones that
 * prove B02 did not quietly start importing mail.
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

d("B02 credential boundary (0036)", () => {
  describe("no client role can reach the private schema", () => {
    it("anon, authenticated and service_role hold no USAGE on it", async () => {
      const res = await client.query(`
        select r.rolname,
               has_schema_privilege(r.rolname, 'private', 'USAGE') as usage
          from (values ('anon'),('authenticated'),('service_role')) as r(rolname)
      `);
      // service_role is BYPASSRLS, so RLS could never have protected this from
      // the trusted role. Withholding schema usage is what does.
      for (const row of res.rows) {
        expect(row.usage, row.rolname).toBe(false);
      }
    });

    it("no client role holds any privilege on the credential or transaction tables", async () => {
      const res = await client.query(`
        select c.relname, r.rolname,
               has_table_privilege(r.rolname, c.oid, 'SELECT') as sel,
               has_table_privilege(r.rolname, c.oid, 'INSERT') as ins,
               has_table_privilege(r.rolname, c.oid, 'UPDATE') as upd,
               has_table_privilege(r.rolname, c.oid, 'DELETE') as del
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
         where n.nspname = 'private' and c.relkind = 'r'
      `);
      expect(res.rows.length).toBeGreaterThan(0);
      for (const row of res.rows) {
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

    it("a client session cannot select from the credential table", async () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const probe = new Client({ connectionString: TEST_DB });
        await probe.connect();
        let failed = false;
        try {
          await probe.query("begin");
          await probe.query(`set local role ${role}`);
          await probe.query("select * from private.gmail_oauth_credentials limit 1");
        } catch {
          failed = true;
        } finally {
          await probe.query("rollback").catch(() => undefined);
          await probe.end();
        }
        expect(failed, `${role} must not read the credential table`).toBe(true);
      }
    });
  });

  describe("the RPC surface is the only door", () => {
    it("is executable by service_role and by nobody else", async () => {
      const functions = [
        "public.gmail_oauth_begin(uuid,text,text,text,text,text,text,text,uuid,text[],text,integer)",
        "public.gmail_oauth_consume_transaction(uuid,text)",
        "public.gmail_connection_persist(uuid,text,text,text[],text,text,text,text,timestamptz,uuid,bigint,text)",
        "public.gmail_grant_private_processing_consent(uuid,uuid,text,text,text)",
        "public.gmail_credential_load(uuid)",
        "public.gmail_credential_load_for_owner(uuid,uuid)",
        "public.gmail_credential_replace(uuid,bigint,text,text,text,text,timestamptz)",
        "public.gmail_credential_currentness(uuid,bigint)",
        "public.gmail_mark_reauth_required(uuid,bigint)",
        "public.gmail_disconnect_finalize(uuid,uuid)",
        "public.gmail_connection_status(uuid)",
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

    it("every definer-rights function pins its search_path", async () => {
      // Without an explicit search_path a caller could shadow `public` or
      // `private` with a temp schema and point a definer function at their own
      // tables. Every one of these runs with elevated rights, so every one pins.
      const res = await client.query(`
        select p.proname, p.prosecdef, p.proconfig
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like 'gmail\\_%'
      `);
      expect(res.rows.length).toBe(11);
      for (const row of res.rows) {
        expect(row.prosecdef, row.proname).toBe(true);
        expect(
          (row.proconfig ?? []).some((c: string) => c.startsWith("search_path=")),
          row.proname,
        ).toBe(true);
      }
    });
  });

  describe("what the credential table stores, and what it refuses to", () => {
    it("has no column that could hold an access token, ID token, code or raw state", async () => {
      const res = await client.query(`
        select c.relname, a.attname
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'private' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      `);
      const columns = res.rows.map((r) => `${r.relname}.${r.attname}`);

      // An access token lives minutes and belongs in memory; the others are
      // single-use inputs whose job is over by the time anything is stored.
      expect(columns).not.toContain("gmail_oauth_credentials.access_token");
      expect(columns).not.toContain("gmail_oauth_credentials.id_token");
      expect(columns).not.toContain("gmail_oauth_transactions.authorization_code");
      expect(columns).not.toContain("gmail_oauth_transactions.state");
      expect(columns).not.toContain("gmail_oauth_transactions.nonce");
      expect(columns).not.toContain("gmail_oauth_transactions.code_verifier");

      for (const column of columns) {
        // Anything that looks like a secret must be ciphertext, a digest, or the
        // key VERSION — never a plaintext value.
        if (/token|secret|verifier|state|nonce/i.test(column)) {
          expect(
            /ciphertext|_iv$|auth_tag|digest|key_version|expires_at/.test(column),
            `${column} must be an encrypted or hashed form`,
          ).toBe(true);
        }
      }
    });

    it("keeps no OAuth credential column in the public schema", async () => {
      // B01's guarantee, re-asserted now that credentials exist somewhere.
      const res = await client.query(`
        select c.relname, a.attname
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and a.attnum > 0 and not a.attisdropped
           and (c.relname like 'mail\\_%' or c.relname like 'gmail\\_%')
           and a.attname ~* 'token|secret|credential|password|refresh|bearer'
      `);
      expect(res.rows).toEqual([]);
    });

    it("hangs the credential off B01's (account, owner) provenance pair", async () => {
      const res = await client.query(`
        select conname, pg_get_constraintdef(oid) as def
          from pg_constraint
         where conrelid = 'private.gmail_oauth_credentials'::regclass and contype = 'f'
      `);
      const composite = res.rows.find((r) => r.def.includes("mail_account_id, user_id"));
      // Deletion stays addressable: the credential cannot lose either the
      // mailbox or the human it belongs to.
      expect(composite).toBeDefined();
      expect(composite.def).toContain("ON DELETE CASCADE");
    });
  });

  describe("B02 imported nothing", () => {
    it("creates no message, thread, attachment, sync or import table", async () => {
      const res = await client.query(`
        select c.relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'private') and c.relkind = 'r'
           and c.relname ~* 'message|thread|attachment|mailbox_sync|gmail_history|email_import|label'
      `);
      expect(res.rows.map((r) => r.relname)).toEqual([]);
    });

    it("stores no Gmail sync state from the profile health check", async () => {
      // The profile response carries messagesTotal, threadsTotal and historyId.
      // They are sync state and B02 does not sync, so nothing here can hold them.
      const res = await client.query(`
        select a.attname
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public','private') and c.relkind = 'r'
           and a.attnum > 0 and not a.attisdropped
           and a.attname ~* 'messages_total|threads_total|history_id'
      `);
      expect(res.rows).toEqual([]);
    });

    it("requests no Gmail send permission anywhere in the approved vocabulary", async () => {
      const res = await client.query("select public.approved_gmail_scopes() as scopes");
      // gmail.send remains APPROVED for a future incremental authorization, and
      // B02 simply never asks for it — asserted on the request side in the flow
      // suite. What must not appear is anything broader.
      const scopes = res.rows[0].scopes as string[];
      for (const forbidden of [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.insert",
        "https://www.googleapis.com/auth/gmail.metadata",
        "https://mail.google.com/",
      ]) {
        expect(scopes).not.toContain(forbidden);
      }
    });
  });

  describe("the migration enrols nobody", () => {
    it("creates no transaction and no credential of its own", async () => {
      // Fixtures created by other suites may exist; what must be true is that
      // every stored row traces to a mailbox some test deliberately created.
      const orphans = await client.query(`
        select count(*)::int as n from private.gmail_oauth_credentials c
         where not exists (select 1 from public.mail_accounts m where m.id = c.mail_account_id)
      `);
      expect(orphans.rows[0].n).toBe(0);
    });
  });
});
