import type { Client } from "pg";

import { B02_REQUESTED_SCOPES } from "@/lib/gmail/contract";
import type { ImportDeps } from "@/lib/gmail/import/worker.server";
import { syncDeps, type SyncDeps } from "@/lib/gmail/sync/worker";
import { createRpcClient } from "../gmail/rpc-harness";
import { connectedMailbox } from "../gmail-import/harness";

import type { FakeIncremental } from "./fake-incremental";

export function rpc(client: Client) {
  return createRpcClient(client) as unknown as ImportDeps["db"];
}

export async function mailbox(client: Client, label: string) {
  return connectedMailbox(client, label);
}

/** A completed historical import. The forward horizon is its window end. */
export async function completedImport(
  client: Client,
  mail: { userId: string; mailAccountId: string },
): Promise<{ runId: string; horizon: Date }> {
  const inserted = await client.query<{ id: string; window_end_at: Date }>(
    `insert into private.gmail_historical_import_runs
       (user_id, mail_account_id, window_start_at, window_end_at, status, phase, completed_at)
     values ($1, $2, now() - interval '400 days', now() - interval '1 day',
             'completed', 'finished', now())
     returning id, window_end_at`,
    [mail.userId, mail.mailAccountId],
  );
  return { runId: inserted.rows[0]!.id, horizon: inserted.rows[0]!.window_end_at };
}

export async function dueCursor(
  client: Client,
  mail: { userId: string; mailAccountId: string },
  horizon: Date,
  historyId: string | null,
): Promise<void> {
  await client.query(
    `insert into private.gmail_sync_cursors
       (mail_account_id, user_id, history_id, horizon_end_at, next_sync_at)
     values ($1, $2, $3, $4, now())`,
    [mail.mailAccountId, mail.userId, historyId, horizon],
  );
}

export function depsFor(
  client: Client,
  gmail: FakeIncremental,
  runPipeline?: SyncDeps["runPipeline"],
): SyncDeps {
  return syncDeps({
    db: rpc(client),
    gmail,
    accessToken: async () => ({ result: "ok", accessToken: "fake-token" }),
    runPipeline: runPipeline ?? (async () => ({ completed: true })),
  });
}

export async function rawCount(client: Client, mailAccountId: string): Promise<number> {
  const res = await client.query<{ n: number }>(
    "select count(*)::int as n from private.gmail_raw_messages where mail_account_id = $1",
    [mailAccountId],
  );
  return res.rows[0]!.n;
}

export async function cursorOf(client: Client, mailAccountId: string) {
  const res = await client.query(
    "select * from private.gmail_sync_cursors where mail_account_id = $1",
    [mailAccountId],
  );
  return res.rows[0] as {
    history_id: string | null;
    horizon_end_at: Date;
    next_sync_at: Date;
    login_sync_requested: boolean;
    pipeline_pending: boolean;
  };
}

export const SCOPES = [...B02_REQUESTED_SCOPES];
