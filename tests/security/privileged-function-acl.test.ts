/**
 * Every SECURITY DEFINER function is named in the ACL matrix.
 *
 * The matrix is the privilege contract: search_path, and whether anon,
 * authenticated, public, and service_role may execute. A new definer that is
 * not listed fails this test. A listed function whose grants drifted fails it
 * too.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

interface MatrixRow {
  schema: string;
  name: string;
  args: string;
  searchPath: string;
  anon: boolean;
  authenticated: boolean;
  serviceRole: boolean;
  public: boolean;
}

const matrix = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "privileged-function-acl.json"),
    "utf8",
  ),
) as MatrixRow[];

function key(row: { schema: string; name: string; args: string }): string {
  return `${row.schema}.${row.name}(${row.args})`;
}

d("privileged function ACL matrix", () => {
  it("matches every security definer in public and private", async () => {
    await setupDatabase();
    const rows = await adminQuery<{
      schema: string;
      name: string;
      args: string;
      search_path: string | null;
      anon: boolean;
      authenticated: boolean;
      service_role: boolean;
      public: boolean;
    }>(
      `select n.nspname as schema,
              p.proname as name,
              pg_get_function_identity_arguments(p.oid) as args,
              (
                select substring(cfg from 'search_path=(.*)')
                  from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
                 where cfg like 'search_path=%'
                 limit 1
              ) as search_path,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
              has_function_privilege('public', p.oid, 'EXECUTE') as public
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef
          and n.nspname in ('public', 'private')
        order by 1, 2, 3`,
    );

    const expected = new Map(matrix.map((row) => [key(row), row]));
    const actual = new Map(rows.map((row) => [key(row), row]));
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());

    for (const row of rows) {
      const contract = expected.get(key(row));
      expect(contract, key(row)).toBeDefined();
      expect(row.search_path ?? "", key(row)).toBe(contract!.searchPath);
      expect(row.anon, key(row)).toBe(contract!.anon);
      expect(row.authenticated, key(row)).toBe(contract!.authenticated);
      expect(row.service_role, key(row)).toBe(contract!.serviceRole);
      expect(row.public, key(row)).toBe(contract!.public);
      expect(row.search_path, `${key(row)} search_path`).not.toBeNull();
    }
  });
});
