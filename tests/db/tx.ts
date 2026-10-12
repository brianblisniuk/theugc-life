/**
 * Explicit-transaction helper for tests that must observe the effect of a
 * statement (queryAs always rolls back) or interleave two sessions.
 * The caller decides commit/rollback; the client always runs `set local role`.
 */
import { Pool, type PoolClient } from "pg";

import type { Role } from "./harness";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    pool = new Pool({ connectionString: url, max: 4 });
  }
  return pool;
}

export async function openSession(role: Role, sub: string | null = null): Promise<PoolClient> {
  const client = await getPool().connect();
  await client.query("begin");
  await client.query(`set local role ${role}`);
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    sub ? JSON.stringify({ sub }) : "{}",
  ]);
  return client;
}

export async function closeSession(
  client: PoolClient,
  outcome: "commit" | "rollback",
): Promise<void> {
  try {
    await client.query(outcome);
  } finally {
    client.release();
  }
}

export async function endTxPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
