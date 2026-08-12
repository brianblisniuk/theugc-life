/**
 * Apply the versioned SQL migrations in supabase/migrations to a Postgres
 * database, in filename order, each in its own transaction.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run db:migrate
 *   DATABASE_URL=postgres://... npm run db:migrate -- --bootstrap
 *
 * `--bootstrap` first applies tests/db/bootstrap.sql, which provides the
 * Supabase primitives (auth schema, roles, auth.uid()) needed when running
 * against a plain Postgres (local dev / CI). Do NOT use --bootstrap against a
 * real Supabase project — it already provides those.
 *
 * This is a thin, dependency-light applier so migrations can be reproduced from
 * an empty database without requiring the Supabase CLI (which needs Docker
 * images that are not always reachable). The Supabase CLI remains the canonical
 * tool for local dev; see README.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const BOOTSTRAP_SQL = path.join(REPO_ROOT, "tests", "db", "bootstrap.sql");

async function main() {
  const bootstrap = process.argv.includes("--bootstrap");
  const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL (or TEST_DATABASE_URL) must be set to apply migrations.");
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    if (bootstrap) {
      const sql = await readFile(BOOTSTRAP_SQL, "utf8");
      await client.query(sql);
      console.info("[migrate] applied bootstrap.sql");
    }

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("commit");
        console.info(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration failed: ${file}\n${(err as Error).message}`);
      }
    }

    console.info(`[migrate] done (${files.length} migrations).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
