/**
 * Shared helpers for the import CLI (server/admin tooling). Connects to Postgres
 * via DATABASE_URL (falls back to TEST_DATABASE_URL for local dev). Raw rows are
 * never dumped to logs (IMPORT_SPEC §12).
 */
import { Client } from "pg";

export type Args = Record<string, string | boolean>;

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

export function requireString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required --${key} <value>`);
  }
  return v;
}

export async function getClient(): Promise<Client> {
  const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set for import commands that touch the database.");
  }
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

export function fail(message: string): never {
  console.error(`\n[import] ERROR: ${message}\n`);
  process.exit(1);
}
