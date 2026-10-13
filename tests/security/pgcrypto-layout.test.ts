/**
 * pgcrypto lives in `public` on the test harness and in `extensions` on hosted
 * Supabase. 0044's SQL function pins a search_path that starts at public and
 * calls unqualified digest(). 0039 installs public wrappers only for the
 * hosted layout. Removing that shim makes the hosted-layout create fail.
 */
import { readdirSync, readFileSync } from "node:fs";
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

      const privileges = await client.query<{
        anon: boolean;
        service_role: boolean;
        random_anon: boolean;
        random_service_role: boolean;
      }>(
        `select has_function_privilege('anon', 'public.digest(text, text)', 'EXECUTE') as anon,
                has_function_privilege('service_role', 'public.digest(text, text)', 'EXECUTE') as service_role,
                has_function_privilege('anon', 'public.gen_random_bytes(integer)', 'EXECUTE') as random_anon,
                has_function_privilege('service_role', 'public.gen_random_bytes(integer)', 'EXECUTE') as random_service_role`,
      );
      expect(privileges.rows[0]!.anon).toBe(false);
      expect(privileges.rows[0]!.service_role).toBe(true);
      expect(privileges.rows[0]!.random_anon).toBe(false);
      expect(privileges.rows[0]!.random_service_role).toBe(true);

      const share = migration("0053_creator_share_link.sql");
      const hashSql = share.match(
        /create or replace function public\.creator_share_token_hash\(p_token text\)[\s\S]*?\$\$;/,
      );
      const randomSql = share.match(
        /create or replace function public\.creator_share_random_token\(\)[\s\S]*?\$\$;/,
      );
      if (!hashSql?.[0] || !randomSql?.[0]) {
        throw new Error("0053 is missing the public.digest share functions");
      }
      await client.query(hashSql[0]);
      await client.query(randomSql[0]);
      const hashedToken = await client.query<{ hash: Buffer }>(
        "select public.creator_share_token_hash('abc') as hash",
      );
      expect(hashedToken.rows[0]!.hash).toHaveLength(32);
      const token = await client.query<{ token: string }>(
        "select public.creator_share_random_token() as token",
      );
      expect(token.rows[0]!.token).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });

});

/**
 * Unqualified digest() is resolved when the function is created. A pinned
 * search_path that omits public cannot see pgcrypto in extensions, and it
 * cannot see the public wrapper 0039 installs. A runtime `schema || '.digest'`
 * binding is the same hole: the source never names public.digest, and an
 * empty search_path will not fall back to the wrapper.
 */
function digestCallViolations(migrationsDir: string): string[] {
  const violations: string[] = [];
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const source = readFileSync(path.join(migrationsDir, file), "utf8");
    if (/nspname\s*\|\|\s*'\.digest'/.test(source)) {
      violations.push(`${file}: digest() schema is chosen at runtime`);
    }
    const masked = maskSql(source);
    const call = /digest\s*\(/gi;
    for (const match of masked.matchAll(call)) {
      const index = match.index ?? 0;
      const previous = index === 0 ? "" : masked[index - 1]!;
      if (/[.\w]/.test(previous)) continue;
      const searchPath = searchPathBefore(masked, index);
      if (searchPath === "includes-public" || searchPath === "unpinned") continue;
      const line = masked.slice(0, index).split("\n").length;
      violations.push(`${file}:${line} unqualified digest() with search_path ${searchPath}`);
    }
  }
  return violations;
}

function searchPathBefore(masked: string, index: number): "includes-public" | "unpinned" | string {
  const head = masked.slice(0, index);
  const creates = [...head.matchAll(/create\s+(?:or\s+replace\s+)?function\b/gi)];
  const start = creates.at(-1)?.index;
  if (start === undefined) return "unpinned";
  const between = masked.slice(start, index);
  const pathMatch = between.match(/set\s+search_path\s*(?:=|to)[ \t]*([^\n;]*)/i);
  if (!pathMatch) return "unpinned";
  const items = pathMatch[1]!.split(",").map((item) =>
    item
      .trim()
      .replace(/^"+|"+$/g, "")
      .replace(/^'+|'+$/g, ""),
  );
  if (items.includes("public")) return "includes-public";
  return items.filter(Boolean).join(", ") || "empty";
}

function maskSql(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("--", i)) {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (source[i] === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "'" && source[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (source[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out += source.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

describe("digest() across migrations", () => {
  it("rejects unqualified digest() unless search_path includes public", () => {
    const migrationsDir = path.join(root, "supabase/migrations");
    expect(digestCallViolations(migrationsDir)).toEqual([]);
  });
});
