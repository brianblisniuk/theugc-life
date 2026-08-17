/**
 * A dedicated single `pg.Client` for ingestion tests.
 *
 * The shared DB harness exposes a POOL, and a pool is wrong here: the writer
 * wraps each destination in `begin … commit`, and on a pool those statements
 * can land on different connections, which would silently defeat the very
 * transaction guarantee these tests exist to check.
 */
import { Client } from "pg";

let client: Client | null = null;

export async function connectClient(): Promise<Client> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");
  client = new Client({ connectionString });
  await client.connect();
  return client;
}

export function getRawClient(): Client {
  if (!client) throw new Error("connectClient() has not been called");
  return client;
}

export async function endClient(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
  }
}
