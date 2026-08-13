/**
 * Persistent-target safety guard tests (SPRINT_1C_PERSISTENT_PREFLIGHT.md).
 *
 * All connection strings here are INVENTED — no real host, credential, or
 * database is referenced. These tests assert the guard classification and the
 * apply-time refusal rules; the read-only `runPreflight` inspection is exercised
 * by the DB-gated import suites.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertPersistentApplyTarget,
  classifyDatabaseUrl,
  PersistentTargetError,
  runPreflight,
} from "@/lib/import/preflight";

import { hasTestDb, setupDatabase } from "../db/harness";

describe("classifyDatabaseUrl — non-secret classification", () => {
  it("reports absent when no URL is provided", () => {
    const c = classifyDatabaseUrl(undefined);
    expect(c.present).toBe(false);
    expect(c.isRemote).toBe(false);
    expect(c.redactedTarget).toBe("(absent)");
  });

  it("classifies a loopback target as local (not remote)", () => {
    const c = classifyDatabaseUrl("postgresql://user:secret@127.0.0.1:55432/theugc_test");
    expect(c.isRemote).toBe(false);
    expect(c.hostClass).toBe("loopback");
    expect(c.databaseName).toBe("theugc_test");
  });

  it("classifies localhost as local", () => {
    expect(classifyDatabaseUrl("postgresql://u:p@localhost:5432/db").hostClass).toBe("localhost");
  });

  it("classifies the standard local-Supabase target as local-supabase", () => {
    const c = classifyDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(c.hostClass).toBe("local-supabase");
    expect(c.isRemote).toBe(false);
  });

  it("classifies RFC1918 private hosts as non-remote", () => {
    expect(classifyDatabaseUrl("postgresql://u:p@10.0.0.5:5432/db").hostClass).toBe(
      "private-network",
    );
    expect(classifyDatabaseUrl("postgresql://u:p@192.168.1.10:5432/db").isRemote).toBe(false);
  });

  it("classifies a public remote host as remote", () => {
    const c = classifyDatabaseUrl(
      "postgresql://postgres:secret@db.invented-ref.supabase.co:5432/postgres?sslmode=require",
    );
    expect(c.isRemote).toBe(true);
    expect(c.hostClass).toBe("remote");
    expect(c.sslMode).toBe("require");
    expect(c.databaseName).toBe("postgres");
  });

  it("NEVER includes the username, password, or host in redactedTarget", () => {
    const c = classifyDatabaseUrl(
      "postgresql://admin:sup3r-secret@db.invented-ref.supabase.co:5432/prod?sslmode=require",
    );
    expect(c.redactedTarget).not.toContain("sup3r-secret");
    expect(c.redactedTarget).not.toContain("admin");
    expect(c.redactedTarget).not.toContain("db.invented-ref.supabase.co");
    // Only class + db name + ssl are surfaced.
    expect(c.redactedTarget).toContain("class=remote");
    expect(c.redactedTarget).toContain("db=prod");
  });

  it("parses a libpq DSN connection string without leaking the password", () => {
    const c = classifyDatabaseUrl(
      "host=db.invented-ref.example.com port=5432 dbname=prod user=svc password=nope sslmode=verify-full",
    );
    expect(c.hostClass).toBe("remote");
    expect(c.databaseName).toBe("prod");
    expect(c.sslMode).toBe("verify-full");
    expect(c.redactedTarget).not.toContain("nope");
  });
});

describe("assertPersistentApplyTarget — real --apply guard", () => {
  it("throws when DATABASE_URL is missing (no TEST_DATABASE_URL fallback)", () => {
    const env = { TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/theugc_test" };
    expect(() => assertPersistentApplyTarget(env)).toThrow(PersistentTargetError);
    expect(() => assertPersistentApplyTarget(env)).toThrow(/DATABASE_URL is required/i);
  });

  it("throws when DATABASE_URL is only a TEST/local target", () => {
    const env = {
      DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/theugc_test",
    };
    expect(() => assertPersistentApplyTarget(env)).toThrow(/non-remote target/i);
  });

  it("refuses the standard local-Supabase target", () => {
    const env = {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:54322/postgres",
    };
    expect(() => assertPersistentApplyTarget(env)).toThrow(PersistentTargetError);
  });

  it("accepts an explicit remote persistent target", () => {
    const env = {
      DATABASE_URL:
        "postgresql://postgres:secret@db.invented-ref.supabase.co:5432/postgres?sslmode=require",
      TEST_DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/theugc_test",
    };
    const { classification } = assertPersistentApplyTarget(env);
    expect(classification.isRemote).toBe(true);
    expect(classification.hostClass).toBe("remote");
  });

  it("never leaks a secret in the refusal error message", () => {
    const env = {
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    };
    try {
      assertPersistentApplyTarget(env);
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain("postgres:postgres");
    }
  });
});

const d = describe.skipIf(!hasTestDb);

d("runPreflight — read-only inspection (synthetic DB)", () => {
  let client: Client;
  beforeAll(async () => {
    if (!hasTestDb) return;
    await setupDatabase();
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
  });
  afterAll(async () => {
    if (client) await client.end();
  });

  it("reports schema-ready with baseline counts and detects UAE/Dubai readiness", async () => {
    // Fresh migrated schema → all required objects present.
    const before = await runPreflight(client);
    expect(before.schemaReady).toBe(true);
    expect(before.missing).toEqual([]);
    expect(Object.keys(before.baselineCounts)).toContain("hotels");
    // The canonical UAE/Dubai nodes are not seeded by migrations.
    expect(before.destinations.uaeOk).toBe(false);
    expect(before.destinations.dubaiOk).toBe(false);

    // Seed the minimum canonical hierarchy the preflight checks for.
    await client.query(
      `insert into public.destinations (name, slug, type, country_code)
         values ('United Arab Emirates','united-arab-emirates','country','AE')
       on conflict (slug) do nothing`,
    );
    await client.query(
      `insert into public.destinations (name, slug, type, country_code, parent_destination_id)
         select 'Dubai','dubai','city','AE', id from public.destinations where slug='united-arab-emirates'
       on conflict (slug) do nothing`,
    );

    const after = await runPreflight(client);
    expect(after.schemaReady).toBe(true);
    expect(after.destinations.uaeOk).toBe(true);
    expect(after.destinations.dubaiOk).toBe(true);
  });
});
