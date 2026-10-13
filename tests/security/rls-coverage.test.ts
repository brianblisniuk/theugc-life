/**
 * Every public table has RLS enabled.
 *
 * The repo pattern is ENABLE ROW LEVEL SECURITY and not FORCE. A table that
 * skips ENABLE fails. Force stays uniform with that pattern: none of the
 * public tables force it, because client roles are not the table owner.
 */
import { describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

d("public tables enable row level security", () => {
  it("every public table has RLS enabled and none force it", async () => {
    await setupDatabase();
    const rows = await adminQuery<{
      relname: string;
      rls: boolean;
      forced: boolean;
    }>(
      `select c.relname,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as forced
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
        order by c.relname`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const missing = rows.filter((row) => !row.rls).map((row) => row.relname);
    const forced = rows.filter((row) => row.forced).map((row) => row.relname);
    expect(missing).toEqual([]);
    expect(forced).toEqual([]);
  });
});
