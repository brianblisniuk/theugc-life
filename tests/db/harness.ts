/**
 * PostgreSQL test harness for RLS/permission tests.
 *
 * Applies tests/db/bootstrap.sql (Supabase compat shim) + all versioned
 * migrations to a fresh schema, then exposes helpers to run queries as a
 * specific Postgres role (`anon` / `authenticated` / `service_role`) while
 * impersonating a user via the `request.jwt.claims` GUC — exactly how Supabase
 * evaluates `auth.uid()`.
 *
 * Gated by TEST_DATABASE_URL: when unset, `hasTestDb` is false and RLS suites
 * skip with a clear message so `npm test` still runs non-DB suites locally.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const BOOTSTRAP_SQL = path.join(REPO_ROOT, "tests", "db", "bootstrap.sql");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

let pool: Pool | null = null;
let setupPromise: Promise<void> | null = null;

function getPool(): Pool {
  if (!pool) {
    if (!TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  }
  return pool;
}

/** Reset schemas and apply bootstrap + migrations. Idempotent per process. */
export function setupDatabase(): Promise<void> {
  if (!setupPromise) {
    setupPromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("drop schema if exists public cascade");
        await client.query("drop schema if exists auth cascade");
        await client.query("create schema public");
        await client.query("grant all on schema public to current_user");

        const bootstrap = await readFile(BOOTSTRAP_SQL, "utf8");
        await client.query(bootstrap);

        const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
        for (const file of files) {
          const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
          await client.query(sql);
        }
      } finally {
        client.release();
      }
    })();
  }
  return setupPromise;
}

/** Run a query as the superuser connection (bypasses RLS). For seeding/asserts. */
export async function adminQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(sql, params);
  return res.rows as T[];
}

export type Role = "anon" | "authenticated" | "service_role";

export interface AsOptions {
  role: Role;
  /** Authenticated user UUID placed in the JWT `sub` claim (null for anon). */
  sub?: string | null;
}

export interface AsResult<T> {
  rows: T[];
  /** Postgres error, if the statement was rejected (RLS/grant violation). */
  error: { code?: string; message: string } | null;
}

/**
 * Execute a single statement impersonating a role + user, inside a rolled-back
 * transaction so tests never mutate shared state. Grant/RLS rejections are
 * captured as `error` rather than thrown, so tests can assert on denial.
 */
export async function queryAs<T = Record<string, unknown>>(
  opts: AsOptions,
  sql: string,
  params: unknown[] = [],
): Promise<AsResult<T>> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${opts.role}`);
    const claims = opts.sub ? JSON.stringify({ sub: opts.sub }) : "{}";
    await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    const res = await client.query(sql, params);
    await client.query("rollback");
    return { rows: res.rows as T[], error: null };
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore rollback error */
    }
    const e = err as { code?: string; message: string };
    return { rows: [], error: { code: e.code, message: e.message } };
  } finally {
    client.release();
  }
}

/** Close pool after the suite. */
export async function teardownDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    setupPromise = null;
  }
}
