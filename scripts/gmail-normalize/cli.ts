/**
 * B04 NORMALIZATION — operator worker.
 *
 *   npm run gmail:normalize:run    -- --user-id <uuid> --mail-account-id <uuid> [--limit N]
 *   npm run gmail:normalize:status -- --user-id <uuid> --mail-account-id <uuid>
 *
 * B04 performs ZERO Gmail network activity: every input already lives in
 * `private.gmail_raw_messages`. This command normalizes stale/missing
 * projections for one mailbox in controlled batches until none remain.
 *
 * WHAT THIS COMMAND MAY PRINT: counts and result codes. What it must never
 * print: any address, subject, header value or decoded body text.
 */
import { Client } from "pg";

import { GMAIL_NORMALIZER_VERSION } from "@/lib/gmail/normalize/contract";
// Deliberately `./service`, NOT `./service.server`: the latter carries
// `import "server-only"`, which throws unconditionally outside Next.js's
// bundler (the `react-server` export condition it relies on is never set by
// plain `tsx`/Node) — see `service.ts`'s own doc comment. This CLI builds its
// own `pg`-backed RPC client below and has no reason to load a Supabase admin
// client at all.
import {
  normalizeMailboxUntilIdle,
  requirePositiveInteger,
  type NormalizeDeps,
} from "@/lib/gmail/normalize/service";

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
  // `Number("")` and `Number(null)` are both 0, so a coercion alone would
  // accept an accidental empty flag value as a legitimate small batch size.
  // `requirePositiveInteger` below is what actually rejects 0/negative/NaN/
  // fractional input — this parse step only turns the raw string into the
  // number that check inspects.
  const limit = limitRaw === null ? 50 : Number(limitRaw);
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

/** A minimal service-role RPC client over `pg`, matching gmail-import's CLI style. */
function rpcClient(client: Client) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const placeholders = keys.map((k, i) => `${k} := $${i + 1}`).join(", ");
      const values = keys.map((k) => {
        const value = args[k];
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          return JSON.stringify(value);
        }
        if (Array.isArray(value) && value.some((v) => v !== null && typeof v === "object")) {
          return JSON.stringify(value);
        }
        return value;
      });
      try {
        const res = await client.query(`select public.${name}(${placeholders}) as result`, values);
        return { data: res.rows[0]?.result ?? null, error: null };
      } catch (error) {
        return { data: null, error: error as Error };
      }
    },
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
  const db = rpcClient(client) as unknown as NormalizeDeps["db"];

  try {
    if (args.command === "status") {
      const { data } = await db.rpc("gmail_normalize_status", {
        p_user_id: args.userId,
        p_mail_account_id: args.mailAccountId,
        p_normalizer_version: GMAIL_NORMALIZER_VERSION,
      });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (args.command === "run") {
      const summary = await normalizeMailboxUntilIdle(
        { db },
        { userId: args.userId, mailAccountId: args.mailAccountId, batchSize: args.limit },
      );
      // `outcomes` carries provider message ids for the library's own
      // retry bookkeeping; this operator surface never prints one.
      const { outcomes: _outcomes, ...reportable } = summary;
      console.log(JSON.stringify(reportable, null, 2));
      if (!summary.completed) {
        console.error(
          `gmail:normalize:run did not reach idle: ${summary.gaveUpCount} candidate(s) did not normalize this run.`,
        );
        process.exitCode = 1;
      }
      return;
    }

    throw new Error("Usage: run | status");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].includes("gmail-normalize")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "gmail normalize failed");
    process.exitCode = 1;
  });
}
