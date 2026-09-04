import { createHash } from "node:crypto";

import { Client } from "pg";

import {
  recordCreatorDecision,
  type OutreachDeps,
  type RecordCreatorDecisionInput,
  type RecordCreatorDecisionResult,
} from "@/lib/gmail/outreach/service";
import { GMAIL_NORMALIZER_VERSION } from "@/lib/gmail/normalize/contract";
import { normalizeOneCandidate } from "@/lib/gmail/normalize/service";
import { createRpcClient, createTestUser } from "../gmail/rpc-harness";
import {
  buildSanitizedMessage,
  connectedMailbox,
  insertRawMessage,
  type RawHeaderFixture,
  type RawPartFixture,
} from "../gmail-normalize/harness";

export { connectedMailbox, createTestUser };

/**
 * B05 test fixtures against REAL PostgreSQL. Machine/human separation,
 * source-evidence fencing, catalog-epoch staleness and the deletion/
 * disconnect boundary all live inside 0039's own functions and constraints,
 * so a mocked database would test nothing that matters.
 */

interface ThenableResult<T> {
  then<R>(resolve: (v: { data: T[] | null; error: Error | null }) => R): Promise<R>;
}

/**
 * Parses a PostgREST-style `.or("col.op.value,col.op.value")` filter string
 * into a SQL WHERE clause. Only `eq` and `ilike` are needed by B05's own
 * queries — the exact operators `getCatalogSnapshot` uses (EXTERNAL AUDIT
 * AMENDMENT #1, Finding 4/5's bounded, case-insensitive catalog lookup).
 */
function parseOrFilter(filterString: string): { clause: string; params: unknown[] } {
  const parts = filterString.split(",").map((p) => p.trim());
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const part of parts) {
    const match = /^([a-z_]+)\.(eq|ilike)\.(.*)$/i.exec(part);
    if (!match) throw new Error(`test .or() shim: unsupported filter clause "${part}"`);
    const [, column, op, rawValue] = match;
    params.push(rawValue);
    clauses.push(
      op === "eq" ? `${column} = $${params.length}` : `${column} ilike $${params.length}`,
    );
  }
  return { clause: clauses.length > 0 ? `(${clauses.join(" or ")})` : "false", params };
}

/** Adds the minimal `.from(table).select(cols)[.in(col, values)]` shim `OutreachDeps.db` needs, over a real pg client. */
export function outreachDeps(client: Client): OutreachDeps {
  const rpc = createRpcClient(client);
  const from = (table: string) => ({
    select(columns: string) {
      const cols = columns
        .split(",")
        .map((c) => c.trim())
        .join(", ");
      const run = async (whereSql: string, params: unknown[]) => {
        const res = await client.query(`select ${cols} from public.${table} ${whereSql}`, params);
        return { data: res.rows, error: null };
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
  return { db: { ...rpc, from } as unknown as OutreachDeps["db"] };
}

/**
 * EXTERNAL AUDIT AMENDMENT #1, Finding 2: `recordCreatorDecision` no longer
 * accepts a `userId` — it derives the actor from `auth.uid()`, which reads
 * the `request.jwt.claims` GUC PostgREST would normally set from a real
 * user's session. This test harness talks to Postgres directly over one
 * persistent connection (no PostgREST in front of it), so it simulates that
 * exact mechanism itself: `set_config('request.jwt.claims', ..., false)`
 * (session-scoped, so it survives past this one statement) on `client`
 * BEFORE calling the real `recordCreatorDecision`, naming the human this
 * call is impersonating. This is the ONLY place in the B05 test suite that
 * needs to simulate a real creator identity — every other B05 RPC remains
 * service-role/machine and never reads `auth.uid()` at all.
 */
export async function recordCreatorDecisionAs(
  client: Client,
  userId: string,
  deps: OutreachDeps,
  input: { mailAccountId: string; normalizedThreadId: string } & RecordCreatorDecisionInput,
): Promise<RecordCreatorDecisionResult> {
  await client.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  return recordCreatorDecision(deps, input);
}

/** Insert a raw B03 message and normalize it via B04, in one step, for B05 fixtures. */
export async function insertNormalizedThread(
  client: Client,
  input: {
    userId: string;
    mailAccountId: string;
    providerMessageId: string;
    providerThreadId: string;
    internalDateMs?: number;
    sent?: boolean;
    subject?: string;
    toRecipients?: string[];
    ccRecipients?: string[];
    bccRecipients?: string[];
    bodyText?: string;
  },
): Promise<{ normalizedThreadId: string; normalizedMessageId: string }> {
  const messageHeaders: RawHeaderFixture[] = [{ name: "subject", value: input.subject ?? "hello" }];
  for (const to of input.toRecipients ?? []) messageHeaders.push({ name: "to", value: to });
  for (const cc of input.ccRecipients ?? []) messageHeaders.push({ name: "cc", value: cc });
  for (const bcc of input.bccRecipients ?? []) messageHeaders.push({ name: "bcc", value: bcc });

  const bodyText = input.bodyText ?? "hello";
  const payload: RawPartFixture = {
    mimeType: "text/plain",
    body: { size: bodyText.length, data: Buffer.from(bodyText, "utf8").toString("base64url") },
  };

  const sanitized = buildSanitizedMessage({
    providerMessageId: input.providerMessageId,
    providerThreadId: input.providerThreadId,
    internalDateMs: input.internalDateMs ?? Date.now(),
    labelIds: input.sent === false ? ["INBOX"] : ["SENT"],
    messageHeaders,
    payload,
  });

  const { payloadSha256 } = await insertRawMessage(client, {
    mailAccountId: input.mailAccountId,
    userId: input.userId,
    sanitized,
  });

  const normalizeDeps = {
    db: createRpcClient(
      client,
    ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
  };
  const outcome = await normalizeOneCandidate(normalizeDeps, input.userId, {
    mail_account_id: input.mailAccountId,
    provider_message_id: input.providerMessageId,
    provider_thread_id: input.providerThreadId,
    internal_date_ms: input.internalDateMs ?? Date.now(),
    label_ids: input.sent === false ? ["INBOX"] : ["SENT"],
    sanitized_payload: sanitized,
    payload_sha256: payloadSha256,
  });

  if (outcome.result !== "ok") {
    throw new Error(`fixture normalization failed: ${JSON.stringify(outcome)}`);
  }

  return {
    normalizedThreadId: outcome.normalizedThreadId,
    normalizedMessageId: outcome.normalizedMessageId,
  };
}

export { GMAIL_NORMALIZER_VERSION };

export async function threadSignalRow(client: Client, normalizedThreadId: string) {
  const res = await client.query(
    "select * from private.gmail_outreach_thread_signals where normalized_thread_id = $1",
    [normalizedThreadId],
  );
  return res.rows[0] ?? null;
}

export async function creatorDecisionRow(client: Client, normalizedThreadId: string) {
  const res = await client.query(
    "select * from private.gmail_outreach_creator_decisions where normalized_thread_id = $1",
    [normalizedThreadId],
  );
  return res.rows[0] ?? null;
}

export async function observedRecipientsOf(client: Client, normalizedThreadId: string) {
  const res = await client.query(
    "select * from private.gmail_outreach_observed_recipients where normalized_thread_id = $1 order by created_at",
    [normalizedThreadId],
  );
  return res.rows;
}

export async function targetObservationsOf(client: Client, normalizedThreadId: string) {
  const res = await client.query(
    "select * from private.gmail_outreach_target_observations where normalized_thread_id = $1 order by created_at",
    [normalizedThreadId],
  );
  return res.rows;
}

export async function confirmedTargetsOf(client: Client, normalizedThreadId: string) {
  const res = await client.query(
    "select * from private.gmail_outreach_target_confirmations where normalized_thread_id = $1",
    [normalizedThreadId],
  );
  return res.rows;
}

export async function decisionEventsOf(client: Client, normalizedThreadId: string) {
  const res = await client.query(
    "select * from private.gmail_outreach_creator_decision_events where normalized_thread_id = $1 order by event_seq",
    [normalizedThreadId],
  );
  return res.rows;
}

export function randomProviderId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** A syntactically valid sha256-shaped fingerprint for fixtures that insert `observation_fingerprint` directly. */
export function randomFingerprint(): string {
  return createHash("sha256").update(randomProviderId("fp")).digest("hex");
}
