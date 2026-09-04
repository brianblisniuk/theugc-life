/**
 * B05 OUTREACH INTERPRETATION — operator worker.
 *
 *   npm run gmail:outreach:run    -- --user-id <uuid> --mail-account-id <uuid> [--limit N]
 *   npm run gmail:outreach:status -- --user-id <uuid> --mail-account-id <uuid>
 *
 * B05 performs ZERO Gmail network activity: every input already lives in
 * B04's normalized tables. This command interprets stale/missing threads for
 * one mailbox in controlled batches until none remain.
 *
 * WHAT THIS COMMAND MAY PRINT: counts and result codes. What it must never
 * print: any address, subject, header value, decoded body text, or business
 * name extracted from one.
 */
import { Client } from "pg";

// Deliberately `./service`, NOT `./service.server` — see that module's own
// doc comment and B04's `cli.ts` for why a `server-only`-marked module can
// never run from a plain `tsx`/Node CLI process at all.
import {
  outreachInterpretMailboxUntilIdle,
  requirePositiveInteger,
  type OutreachDeps,
} from "@/lib/gmail/outreach/service";

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

/** A minimal service-role RPC client over `pg`, matching gmail-normalize's CLI style. */
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

interface ThenableResult<T> {
  then<R>(resolve: (v: { data: T[] | null; error: Error | null }) => R): Promise<R>;
}

/** Parses a PostgREST-style `.or("col.op.value,...")` filter — see `tests/gmail-outreach/harness.ts`'s identical shim for why (Finding 4/5's bounded, case-insensitive catalog lookup). */
function parseOrFilter(filterString: string): { clause: string; params: unknown[] } {
  const parts = filterString.split(",").map((p) => p.trim());
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const part of parts) {
    const match = /^([a-z_]+)\.(eq|ilike)\.(.*)$/i.exec(part);
    if (!match) throw new Error(`CLI .or() shim: unsupported filter clause "${part}"`);
    const [, column, op, rawValue] = match;
    params.push(rawValue);
    clauses.push(
      op === "eq" ? `${column} = $${params.length}` : `${column} ilike $${params.length}`,
    );
  }
  return { clause: clauses.length > 0 ? `(${clauses.join(" or ")})` : "false", params };
}

/** A minimal `.from(table).select(cols)[.in(col, values)|.or(filter)]` shim over `pg`, sufficient for the catalog snapshot lookup. */
function fromOf(client: Client) {
  return (table: string) => ({
    select(columns: string) {
      const cols = columns
        .split(",")
        .map((c) => c.trim())
        .join(", ");
      const run = async (whereSql: string, params: unknown[]) => {
        try {
          const res = await client.query(`select ${cols} from public.${table} ${whereSql}`, params);
          return { data: res.rows, error: null };
        } catch (error) {
          return { data: null, error: error as Error };
        }
      };
      return {
        then<R>(resolve: (v: { data: unknown[] | null; error: Error | null }) => R): Promise<R> {
          return run("", []).then(resolve);
        },
        in(column: string, values: unknown[]): ThenableResult<unknown> {
          return {
            then<R>(
              resolve: (v: { data: unknown[] | null; error: Error | null }) => R,
            ): Promise<R> {
              return run(`where ${column} = any($1)`, [values]).then(resolve);
            },
          } as ThenableResult<unknown>;
        },
        or(filterString: string): ThenableResult<unknown> {
          const { clause, params } = parseOrFilter(filterString);
          return {
            then<R>(
              resolve: (v: { data: unknown[] | null; error: Error | null }) => R,
            ): Promise<R> {
              return run(`where ${clause}`, params).then(resolve);
            },
          } as ThenableResult<unknown>;
        },
      };
    },
  });
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
  const db = { rpc: rpcOf(client), from: fromOf(client) } as unknown as OutreachDeps["db"];

  try {
    if (args.command === "status") {
      const { data } = await db.rpc("gmail_outreach_status", {
        p_user_id: args.userId,
        p_mail_account_id: args.mailAccountId,
      });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (args.command === "run") {
      const summary = await outreachInterpretMailboxUntilIdle(
        { db },
        { userId: args.userId, mailAccountId: args.mailAccountId, batchSize: args.limit },
      );
      const { outcomes: _outcomes, ...reportable } = summary;
      console.log(JSON.stringify(reportable, null, 2));
      if (!summary.completed) {
        console.error(
          `gmail:outreach:run did not reach idle: ${summary.gaveUpCount} candidate(s) did not interpret this run.`,
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

if (process.argv[1] && process.argv[1].includes("gmail-outreach")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "gmail outreach interpretation failed");
    process.exitCode = 1;
  });
}
