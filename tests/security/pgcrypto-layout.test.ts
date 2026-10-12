/**
 * pgcrypto lives in `public` on the test harness and in `extensions` on hosted
 * Supabase. 0044's SQL function pins a search_path that starts at public and
 * calls unqualified digest(). 0039 installs public wrappers only for the
 * hosted layout. Removing that shim makes the hosted-layout create fail.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function migration(name: string): string {
  return readFileSync(path.join(root, "supabase/migrations", name), "utf8");
}

function shimSql(): string {
  const source = migration("0039_gmail_outreach_commercial_targets.sql");
  const match = source.match(
    /-- pgcrypto-public-shim:begin\n([\s\S]*?)\n-- pgcrypto-public-shim:end/,
  );
  if (!match?.[1]) throw new Error("0039 is missing the pgcrypto public shim");
  return match[1];
}

d("pgcrypto layout", () => {
  it("keeps the extension digest in public on the test harness", async () => {
    await setupDatabase();
    const rows = await adminQuery<{ extension_owned: boolean }>(
      `select exists (
         select 1
           from pg_depend d
           join pg_extension e on e.oid = d.refobjid
           join pg_proc p on p.oid = d.objid
           join pg_namespace n on n.oid = p.pronamespace
          where e.extname = 'pgcrypto'
            and n.nspname = 'public'
            and p.proname = 'digest'
            and pg_get_function_identity_arguments(p.oid) = 'text, text'
       ) as extension_owned`,
    );
    expect(rows[0]!.extension_owned).toBe(true);
  });

  it("creates a pinned digest function when pgcrypto is only in extensions", async () => {
    await setupDatabase();
    const shim = shimSql();
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query("begin");
      const configured = await client.query<{ search_path: string | null }>(
        `select (
           select substring(cfg from 'search_path=(.*)')
             from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
            where cfg like 'search_path=%'
            limit 1
         ) as search_path
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private'
            and p.proname = 'gmail_commercial_input_digest'`,
      );
      const searchPath = configured.rows[0]?.search_path ?? "";
      expect(searchPath).toContain("public");
      expect(searchPath).not.toContain("extensions");

      await client.query("create schema if not exists extensions");
      await client.query("alter extension pgcrypto set schema extensions");
      await client.query("savepoint before_shim");
      let createError = "";
      try {
        await client.query(
          `create function pg_temp.pinned_digest_probe() returns text
           language sql
           stable
           set search_path = ${searchPath}
           as $$ select encode(digest('a', 'sha256'), 'hex') $$`,
        );
      } catch (error) {
        createError = error instanceof Error ? error.message : String(error);
        await client.query("rollback to savepoint before_shim");
      }
      expect(createError).toMatch(/digest.*does not exist/);

      await client.query(shim);
      await client.query(
        `create function pg_temp.pinned_digest_probe() returns text
         language sql
         stable
         set search_path = ${searchPath}
         as $$ select encode(digest('a', 'sha256'), 'hex') $$`,
      );
      const hashed = await client.query<{ hex: string }>(
        "select pg_temp.pinned_digest_probe() as hex",
      );
      expect(hashed.rows[0]!.hex).toMatch(/^[0-9a-f]{64}$/);

      const privileges = await client.query<{ anon: boolean; service_role: boolean }>(
        `select has_function_privilege('anon', 'public.digest(text, text)', 'EXECUTE') as anon,
                has_function_privilege('service_role', 'public.digest(text, text)', 'EXECUTE') as service_role`,
      );
      expect(privileges.rows[0]!.anon).toBe(false);
      expect(privileges.rows[0]!.service_role).toBe(true);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });

  it("0053 schema-qualifies digest and gen_random_bytes for both schemas", () => {
    const source = migration("0053_creator_share_link.sql");
    expect(source).toContain("n.nspname in ('extensions', 'public')");
    expect(source).toContain("gen_random_bytes");
    expect(source).toMatch(/when 'extensions' then 0 else 1/);
  });
});
