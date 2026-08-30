/**
 * B03 HISTORICAL IMPORT — operator worker.
 *
 *   npm run gmail:import:start  -- --mail-account-id <uuid> --after <ISO timestamp>
 *   npm run gmail:import:work   -- --run-id <uuid> [--once]
 *   npm run gmail:import:resume -- --run-id <uuid>
 *   npm run gmail:import:status -- --run-id <uuid>
 *
 * THIS IS A PILOT OPERATOR TOOL, AND IT SAYS SO.
 *
 * There is no durable background runtime in this repository yet, and the honest
 * response to that is a command an operator runs — not a fire-and-forget promise
 * in a web request, not a browser that polls while performing Gmail work, and
 * not an in-memory queue that a deploy silently empties. The DATABASE is the
 * truth: if this process dies, run `work` again and the lease expires, the step
 * is reclaimed, and the import resumes exactly where the committed state says.
 *
 * WHAT THIS COMMAND MAY PRINT: a run id, a phase, counts, sanitized error codes
 * and timings. What it must never print: any email content, any address, any
 * subject, a Gmail page token, a provider thread id, or any token. Those rules
 * are the same ones the database enforces on what it stores.
 */
import { Client } from "pg";

import {
  runImportUntilIdle,
  runOneImportStep,
  type ImportDeps,
} from "@/lib/gmail/import/worker.server";

interface Args {
  command: string;
  mailAccountId: string | null;
  userId: string | null;
  runId: string | null;
  after: string | null;
  once: boolean;
}

export function parseImportArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  return {
    command: argv[0] ?? "",
    mailAccountId: get("mail-account-id"),
    userId: get("user-id"),
    runId: get("run-id"),
    after: get("after"),
    once: argv.includes("--once"),
  };
}

/**
 * An absolute timestamp, and nothing looser.
 *
 * B03 refuses "12 months" and friends on purpose: a relative lookback resolved
 * inside a data pipe becomes a permanent product decision nobody made. The
 * operator states the instant; the database fixes the other end.
 */
export function parseWindowStart(value: string | null): Date {
  if (!value) throw new Error("--after <absolute ISO timestamp> is required and has no default.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("--after must be an absolute ISO timestamp, e.g. 2024-01-01T00:00:00Z");
  }
  return parsed;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  return url;
}

/** A minimal service-role RPC client over `pg`, matching the repo's CLI style. */
function rpcClient(client: Client) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const placeholders = keys.map((k, i) => `${k} := $${i + 1}`).join(", ");
      try {
        const res = await client.query(
          `select public.${name}(${placeholders}) as result`,
          keys.map((k) => args[k]),
        );
        return { data: res.rows[0]?.result ?? null, error: null };
      } catch (error) {
        return { data: null, error: error as Error };
      }
    },
  };
}

async function main(): Promise<void> {
  const args = parseImportArgs(process.argv.slice(2));
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  const db = rpcClient(client) as unknown as ImportDeps["db"];

  try {
    if (args.command === "start") {
      if (!args.userId || !args.mailAccountId) {
        throw new Error("--user-id and --mail-account-id are required.");
      }
      const start = parseWindowStart(args.after);
      const { data } = await db.rpc("gmail_historical_import_start", {
        p_user_id: args.userId,
        p_mail_account_id: args.mailAccountId,
        p_window_start_at: start.toISOString(),
      });
      // The window's END came from the database, not from this process.
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (!args.runId || !args.userId) {
      throw new Error("--user-id and --run-id are required.");
    }

    if (args.command === "status") {
      const { data } = await db.rpc("gmail_historical_import_status", {
        p_user_id: args.userId,
        p_run_id: args.runId,
      });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (args.command === "resume") {
      const { data } = await db.rpc("gmail_historical_import_resume", {
        p_user_id: args.userId,
        p_run_id: args.runId,
      });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (args.command === "work") {
      const { defaultImportDeps } = await import("@/lib/gmail/import/worker.server");
      const deps: ImportDeps = { ...defaultImportDeps(), db };
      const outcome = args.once
        ? await runOneImportStep({ userId: args.userId, runId: args.runId }, deps)
        : await runImportUntilIdle({ userId: args.userId, runId: args.runId }, deps);
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }

    throw new Error("Usage: start | work | resume | status");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].includes("gmail-import")) {
  main().catch((error: unknown) => {
    // A sanitized message only: this command talks about a mailbox, and its
    // stderr is somebody's operational log.
    console.error(error instanceof Error ? error.message : "gmail import failed");
    process.exitCode = 1;
  });
}
