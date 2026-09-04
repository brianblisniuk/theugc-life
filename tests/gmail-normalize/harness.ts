import { createHash, randomBytes } from "node:crypto";

import { Client } from "pg";

import type { NormalizeDeps } from "@/lib/gmail/normalize/service";
import { createRpcClient, createTestUser } from "../gmail/rpc-harness";

export { connectedMailbox, setConnectionState, startDeletion } from "../gmail-import/harness";

/**
 * B04 test fixtures against REAL PostgreSQL.
 *
 * Everything B04 guarantees — provenance, invalidation, concurrency, the
 * deleted-state invariant — lives inside 0038's functions and PostgreSQL's own
 * constraints, so a mocked database would test nothing that matters.
 */

export function deps(client: Client): NormalizeDeps {
  return { db: createRpcClient(client) as unknown as NormalizeDeps["db"] };
}

/** Call an RPC directly and unwrap it, for tests that exercise the function itself. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rpcRaw(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const { data, error } = await createRpcClient(client).rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export { createTestUser };

function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface RawHeaderFixture {
  name: string;
  value: string;
}

export interface RawPartFixture {
  mimeType: string;
  headers?: RawHeaderFixture[];
  body?: { size: number; data: string };
  contentOmitted?: true;
  omissionReason?: "attachment" | "non_text" | "external_body";
  size?: number;
  parts?: RawPartFixture[];
}

export interface SanitizedMessageFixture {
  provider_message_id: string;
  provider_thread_id: string;
  internal_date_ms: number;
  label_ids: string[];
  provider_history_id: string | null;
  size_estimate: number | null;
  message_headers: RawHeaderFixture[];
  payload: RawPartFixture;
}

export function buildSanitizedMessage(input: {
  providerMessageId: string;
  providerThreadId: string;
  internalDateMs: number;
  labelIds?: string[];
  messageHeaders?: RawHeaderFixture[];
  payload?: RawPartFixture;
}): SanitizedMessageFixture {
  return {
    provider_message_id: input.providerMessageId,
    provider_thread_id: input.providerThreadId,
    internal_date_ms: input.internalDateMs,
    label_ids: input.labelIds ?? ["SENT"],
    provider_history_id: null,
    size_estimate: null,
    message_headers: input.messageHeaders ?? [{ name: "subject", value: "hello" }],
    payload: input.payload ?? { mimeType: "text/plain", body: { size: 5, data: "aGVsbG8" } },
  };
}

/** Insert one raw B03 message row directly, bypassing B03's own RPCs. */
export async function insertRawMessage(
  client: Client,
  input: {
    mailAccountId: string;
    userId: string;
    sanitized: SanitizedMessageFixture;
  },
): Promise<{ payloadSha256: string }> {
  const payloadSha256 = sha256Of(input.sanitized);
  await client.query(
    `insert into private.gmail_raw_messages
       (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
        label_ids, sanitized_payload, payload_sha256)
     values ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7, $8)`,
    [
      input.mailAccountId,
      input.userId,
      input.sanitized.provider_message_id,
      input.sanitized.provider_thread_id,
      input.sanitized.internal_date_ms,
      input.sanitized.label_ids,
      JSON.stringify(input.sanitized),
      payloadSha256,
    ],
  );
  return { payloadSha256 };
}

/** Simulate a B03 re-import that changes the provider snapshot for an existing raw identity. */
export async function updateRawMessage(
  client: Client,
  input: { mailAccountId: string; providerMessageId: string; sanitized: SanitizedMessageFixture },
): Promise<{ payloadSha256: string }> {
  const payloadSha256 = sha256Of(input.sanitized);
  await client.query(
    `update private.gmail_raw_messages
        set provider_thread_id = $3,
            internal_date = to_timestamp($4 / 1000.0),
            label_ids = $5,
            sanitized_payload = $6,
            payload_sha256 = $7,
            last_seen_at = now()
      where mail_account_id = $1 and provider_message_id = $2`,
    [
      input.mailAccountId,
      input.providerMessageId,
      input.sanitized.provider_thread_id,
      input.sanitized.internal_date_ms,
      input.sanitized.label_ids,
      JSON.stringify(input.sanitized),
      payloadSha256,
    ],
  );
  return { payloadSha256 };
}

export async function rawMessageRow(
  client: Client,
  mailAccountId: string,
  providerMessageId: string,
) {
  const res = await client.query(
    "select * from private.gmail_raw_messages where mail_account_id = $1 and provider_message_id = $2",
    [mailAccountId, providerMessageId],
  );
  return res.rows[0] ?? null;
}

export async function normalizedMessageRow(
  client: Client,
  mailAccountId: string,
  providerMessageId: string,
) {
  const res = await client.query(
    "select * from private.gmail_normalized_messages where mail_account_id = $1 and provider_message_id = $2",
    [mailAccountId, providerMessageId],
  );
  return res.rows[0] ?? null;
}

export async function normalizedThreadRow(
  client: Client,
  mailAccountId: string,
  providerThreadId: string,
) {
  const res = await client.query(
    "select * from private.gmail_normalized_threads where mail_account_id = $1 and provider_thread_id = $2",
    [mailAccountId, providerThreadId],
  );
  return res.rows[0] ?? null;
}

export async function headersOf(client: Client, normalizedMessageId: string) {
  const res = await client.query(
    "select * from private.gmail_normalized_headers where normalized_message_id = $1 order by global_order",
    [normalizedMessageId],
  );
  return res.rows;
}

export async function participantsOf(client: Client, normalizedMessageId: string) {
  const res = await client.query(
    `select p.* from private.gmail_normalized_participants p
      where p.normalized_message_id = $1
      order by p.source_header_id, p.participant_order`,
    [normalizedMessageId],
  );
  return res.rows;
}

export async function referenceTokensOf(client: Client, normalizedMessageId: string) {
  const res = await client.query(
    `select t.* from private.gmail_normalized_reference_tokens t
      where t.normalized_message_id = $1
      order by t.source_header_id, t.token_order`,
    [normalizedMessageId],
  );
  return res.rows;
}

export async function textPartsOf(client: Client, normalizedMessageId: string) {
  const res = await client.query(
    "select * from private.gmail_normalized_text_parts where normalized_message_id = $1 order by part_path",
    [normalizedMessageId],
  );
  return res.rows;
}

export function randomProviderId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}
