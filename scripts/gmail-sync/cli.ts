/**
 * B08 incremental sync — operator worker.
 *
 *   npm run gmail:sync:work -- [--limit N]
 *
 * The database decides who is due (15 minutes since the last completed sync,
 * a creator-login request, or a pipeline catch-up). This process discharges
 * that queue. It prints counts and result codes only.
 *
 * The npm script sets `--conditions=react-server` so the server-only token
 * and Gmail adapter modules load under tsx. Without that condition those
 * modules throw before any mailbox is read.
 */
import { Client } from "pg";

import { B08_SYNC_INTERVAL_MINUTES } from "@/lib/gmail/sync/contract";
import type { SyncDeps } from "@/lib/gmail/sync/worker";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  return url;
}

function limitFrom(argv: readonly string[]): number {
  const index = argv.indexOf("--limit");
  if (index < 0) return 10;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error("--limit must be a positive integer");
  return value;
}

/**
 * Named-argument RPC with the declared parameter types, so a jsonb array is
 * not sent as a Postgres array. Same distinction the test harness makes.
 */
function rpcClient(client: Client) {
  const signatures = new Map<string, Promise<{ names: string[]; types: string[] }>>();
  const load = (name: string) => {
    const cached = signatures.get(name);
    if (cached) return cached;
    const pending = client
      .query(
        `select coalesce(p.proargnames, '{}') as names,
                array(select format_type(t, null) from unnest(p.proargtypes) as t) as types
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1
          limit 1`,
        [name],
      )
      .then((res) => ({
        names: (res.rows[0]?.names ?? []) as string[],
        types: (res.rows[0]?.types ?? []) as string[],
      }));
    signatures.set(name, pending);
    return pending;
  };

  return {
    async rpc(name: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      let signature: { names: string[]; types: string[] };
      try {
        signature = await load(name);
      } catch (error) {
        return { data: null, error: error as Error };
      }
      const declared = (key: string) => {
        const index = signature.names.indexOf(key);
        return index >= 0 ? (signature.types[index] ?? null) : null;
      };
      const values = keys.map((key) => {
        const value = args[key];
        const type = declared(key);
        if (type === "jsonb" || type === "json") {
          return value === null || value === undefined ? null : JSON.stringify(value);
        }
        return value;
      });
      const named = keys
        .map((key, i) => {
          const type = declared(key);
          return `${key} := $${i + 1}${type ? `::${type}` : ""}`;
        })
        .join(", ");
      try {
        const res = await client.query(`select public.${name}(${named}) as result`, values);
        return { data: res.rows[0]?.result ?? null, error: null };
      } catch (error) {
        return { data: null, error: error as Error };
      }
    },
  };
}

async function main(): Promise<void> {
  const limit = limitFrom(process.argv.slice(2));
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    const { getFreshGmailAccessToken } = await import("@/lib/gmail/connection.server");
    const { gmailIncrementalReadAdapter } = await import("@/lib/gmail/sync/read-adapter.server");
    const { runDueSyncs, syncDeps } = await import("@/lib/gmail/sync/worker");
    const deps = syncDeps({
      db: rpcClient(client) as unknown as SyncDeps["db"],
      gmail: gmailIncrementalReadAdapter,
      accessToken: (input) => getFreshGmailAccessToken(input),
    });
    const outcome = await runDueSyncs(deps, limit);
    console.log(
      JSON.stringify({
        interval_minutes: B08_SYNC_INTERVAL_MINUTES,
        accounts: outcome.accounts,
        results: outcome.outcomes.map((item) => item.result),
      }),
    );
  } finally {
    await client.end();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
