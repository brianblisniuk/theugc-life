/**
 * B06 REPLY CHRONOLOGY — operator worker.
 *
 *   npm run gmail:reply:run    -- --user-id <uuid> --mail-account-id <uuid> [--limit N]
 *   npm run gmail:reply:status -- --user-id <uuid> --mail-account-id <uuid>
 *
 * B06 performs ZERO Gmail network activity: every input already lives in
 * B03/B04/B05's tables. This command evaluates stale/missing threads for one
 * mailbox in bounded batches until none remain.
 *
 * WHAT THIS COMMAND MAY PRINT: counts and result codes. What it must never
 * print: any address, subject, header value, decoded body text, or provider
 * message id.
 */
import { Client } from "pg";

// Deliberately `./service`, NOT `./service.server` — see that module's own
// doc comment and B04/B05's `cli.ts` for why a `server-only`-marked module
// can never run from a plain `tsx`/Node CLI process at all.
import {
  getStatus,
  interpretUntilIdle,
  requirePositiveInteger,
  type ReplyDeps,
} from "@/lib/gmail/reply/service";

interface Args {
  command: string;
  userId: string | null;
  mailAccountId: string | null;
  limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  const limitRaw = get("limit");
  const limit = limitRaw === null ? 25 : Number(limitRaw);
  return {
    command: argv[0] ?? "",
    userId: get("user-id"),
    mailAccountId: get("mail-account-id"),
    limit,
  };
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  return url;
}

/** A minimal service-role RPC client over `pg`, matching B05's CLI style. */
function rpcOf(client: Client) {
  return async (name: string, args: Record<string, unknown> = {}) => {
    const keys = Object.keys(args);
    const placeholders = keys.map((k, i) => `${k} := $${i + 1}`).join(", ");
    const values = keys.map((k) => {
      const value = args[k];
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        return JSON.stringify(value);
      if (Array.isArray(value) && value.some((v) => v !== null && typeof v === "object"))
        return JSON.stringify(value);
      return value;
    });
    try {
      const res = await client.query(`select public.${name}(${placeholders}) as result`, values);
      return { data: res.rows[0]?.result ?? null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.userId || !args.mailAccountId) {
    throw new Error("--user-id and --mail-account-id are required.");
  }
  if (args.command === "run") {
    requirePositiveInteger(args.limit, "--limit");
  }

  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  const deps: ReplyDeps = { db: { rpc: rpcOf(client) } as unknown as ReplyDeps["db"] };

  try {
    if (args.command === "status") {
      const status = await getStatus(deps, {
        userId: args.userId,
        mailAccountId: args.mailAccountId,
      });
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    if (args.command === "run") {
      const summary = await interpretUntilIdle(deps, {
        userId: args.userId,
        mailAccountId: args.mailAccountId,
        maxThreads: args.limit,
      });
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    throw new Error("Usage: run | status");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].includes("gmail-reply")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "gmail reply chronology failed");
    process.exitCode = 1;
  });
}
