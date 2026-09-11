import { createHash } from "node:crypto";

import { Client } from "pg";

import { normalizeOneCandidate } from "@/lib/gmail/normalize/service";
import type { ReplyDeps } from "@/lib/gmail/reply/service";
import { createRpcClient, createTestUser } from "../gmail/rpc-harness";
import {
  buildSanitizedMessage,
  connectedMailbox,
  insertRawMessage,
  updateRawMessage,
  type RawHeaderFixture,
} from "../gmail-normalize/harness";
import { startDeletion, withdrawConsent } from "../gmail-import/harness";

export { connectedMailbox, createTestUser, startDeletion, withdrawConsent };

/** B06 test fixtures against REAL PostgreSQL — see B05's identical harness.ts for why. */
export function replyDeps(client: Client): ReplyDeps {
  return { db: createRpcClient(client) as unknown as ReplyDeps["db"] };
}

export function randomProviderId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

interface MessageFixtureInput {
  userId: string;
  mailAccountId: string;
  providerMessageId: string;
  providerThreadId: string;
  internalDateMs: number;
  sent: boolean;
  from?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  subject?: string;
  to?: string;
  bodyText?: string | null;
  htmlBody?: string | null;
}

function buildMessageFixture(input: MessageFixtureInput) {
  const headers: RawHeaderFixture[] = [
    { name: "subject", value: input.subject ?? "hello" },
    { name: "from", value: input.from ?? "someone@example.com" },
    { name: "to", value: input.to ?? "creator@example.com" },
  ];
  if (input.messageId) headers.push({ name: "message-id", value: input.messageId });
  if (input.inReplyTo) headers.push({ name: "in-reply-to", value: input.inReplyTo });
  if (input.references) headers.push({ name: "references", value: input.references });

  const bodyText = input.bodyText ?? (input.htmlBody ? null : "hello");
  const payload =
    input.htmlBody !== undefined && input.htmlBody !== null
      ? {
          mimeType: "text/html",
          body: {
            size: input.htmlBody.length,
            data: Buffer.from(input.htmlBody, "utf8").toString("base64url"),
          },
        }
      : {
          mimeType: "text/plain",
          body: {
            size: (bodyText ?? "").length,
            data: Buffer.from(bodyText ?? "", "utf8").toString("base64url"),
          },
        };

  return buildSanitizedMessage({
    providerMessageId: input.providerMessageId,
    providerThreadId: input.providerThreadId,
    internalDateMs: input.internalDateMs,
    labelIds: input.sent ? ["SENT"] : ["INBOX"],
    messageHeaders: headers,
    payload,
  });
}

async function normalizeFixture(
  client: Client,
  input: MessageFixtureInput,
  sanitized: ReturnType<typeof buildSanitizedMessage>,
  payloadSha256: string,
): Promise<{ normalizedThreadId: string; normalizedMessageId: string }> {
  const normalizeDeps = {
    db: createRpcClient(
      client,
    ) as unknown as import("@/lib/gmail/normalize/service").NormalizeDeps["db"],
  };
  const outcome = await normalizeOneCandidate(normalizeDeps, input.userId, {
    mail_account_id: input.mailAccountId,
    provider_message_id: input.providerMessageId,
    provider_thread_id: input.providerThreadId,
    internal_date_ms: input.internalDateMs,
    label_ids: input.sent ? ["SENT"] : ["INBOX"],
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

/**
 * Insert one raw B03 message with arbitrary headers and normalize it via
 * B04, in one step — the flexible fixture builder B06 needs (From/Message-
 * ID/In-Reply-To/References are all header evidence B05's own
 * `insertNormalizedThread` fixture never had to set).
 */
export async function insertMessage(
  client: Client,
  input: MessageFixtureInput,
): Promise<{ normalizedThreadId: string; normalizedMessageId: string }> {
  const sanitized = buildMessageFixture(input);
  const { payloadSha256 } = await insertRawMessage(client, {
    mailAccountId: input.mailAccountId,
    userId: input.userId,
    sanitized,
  });
  return normalizeFixture(client, input, sanitized, payloadSha256);
}

/**
 * Updates an EXISTING raw message's content (same provider_message_id) and
 * re-normalizes it — a real B04 rebuild: 0038's own invalidation trigger
 * deletes the old normalized_messages row (cascading headers/participants/
 * reference-tokens/text-parts) the instant `payload_sha256` moves, and this
 * re-creates the projection under a NEW normalized_message_id.
 */
export async function updateMessage(
  client: Client,
  input: MessageFixtureInput,
): Promise<{ normalizedThreadId: string; normalizedMessageId: string }> {
  const sanitized = buildMessageFixture(input);
  const { payloadSha256 } = await updateRawMessage(client, {
    mailAccountId: input.mailAccountId,
    providerMessageId: input.providerMessageId,
    sanitized,
  });
  return normalizeFixture(client, input, sanitized, payloadSha256);
}

/** A syntactically valid sha256-shaped digest for fixtures that insert `evidence_digest` directly. */
export function randomDigest(): string {
  return createHash("sha256").update(randomProviderId("digest")).digest("hex");
}

/**
 * Directly inserts the B05 MACHINE/HUMAN rows that decide B06 eligibility
 * (contract §3/§5), bypassing B05's own classifier/matcher entirely — B06's
 * tests need to CONTROL eligibility, not re-prove B05's own already-audited
 * behavior.
 */
export async function setOutreachMachineStatus(
  client: Client,
  input: {
    userId: string;
    mailAccountId: string;
    normalizedThreadId: string;
    outreachStatus:
      "qualified_outreach" | "not_outreach" | "needs_review" | "insufficient_evidence";
  },
): Promise<void> {
  await client.query(
    `insert into private.gmail_outreach_thread_signals
       (user_id, mail_account_id, normalized_thread_id, outreach_status, reason_codes,
        detector_version, evidence_digest, evidence_message_count)
     values ($1, $2, $3, $4, '{}', 'gmail_outreach_rules_v4', $5, 1)
     on conflict (mail_account_id, normalized_thread_id) do update
       set outreach_status = excluded.outreach_status, evaluated_at = now()`,
    [
      input.userId,
      input.mailAccountId,
      input.normalizedThreadId,
      input.outreachStatus,
      randomDigest(),
    ],
  );
}

export async function setOutreachHumanDecision(
  client: Client,
  input: {
    userId: string;
    mailAccountId: string;
    normalizedThreadId: string;
    outreachDecision: "outreach_confirmed" | "not_outreach_confirmed";
  },
): Promise<void> {
  await client.query(
    `insert into private.gmail_outreach_creator_decisions
       (user_id, mail_account_id, normalized_thread_id, outreach_decision)
     values ($1, $2, $3, $4)
     on conflict (mail_account_id, normalized_thread_id) do update
       set outreach_decision = excluded.outreach_decision, updated_at = now()`,
    [input.userId, input.mailAccountId, input.normalizedThreadId, input.outreachDecision],
  );
}

/**
 * Directly inserts a COMPLETED B03 import run plus a `complete` thread-work
 * row for the exact provider thread — the accepted V1 observation-horizon
 * proof (contract §11/§18): "the greatest window_end_at among completed B03
 * runs whose thread-work row for this exact provider thread is complete."
 */
export async function insertObservedHorizon(
  client: Client,
  input: {
    userId: string;
    mailAccountId: string;
    providerThreadId: string;
    windowStartAt: Date;
    windowEndAt: Date;
  },
): Promise<void> {
  const run = await client.query(
    `insert into private.gmail_historical_import_runs
       (user_id, mail_account_id, window_start_at, window_end_at, status, phase, completed_at)
     values ($1, $2, $3, $4, 'completed', 'finished', now())
     returning id`,
    [
      input.userId,
      input.mailAccountId,
      input.windowStartAt.toISOString(),
      input.windowEndAt.toISOString(),
    ],
  );
  await client.query(
    `insert into private.gmail_historical_import_threads
       (run_id, user_id, mail_account_id, provider_thread_id, status, completed_at)
     values ($1, $2, $3, $4, 'complete', now())`,
    [run.rows[0].id, input.userId, input.mailAccountId, input.providerThreadId],
  );
}

export async function messageObservationsOf(client: Client, normalizedThreadId: string) {
  const res = await client.query(
    "select * from private.gmail_reply_message_observations where normalized_thread_id = $1 order by internal_date",
    [normalizedThreadId],
  );
  return res.rows;
}

export async function threadSummaryOf(client: Client, normalizedThreadId: string) {
  const res = await client.query(
    "select * from private.gmail_reply_thread_summaries where normalized_thread_id = $1",
    [normalizedThreadId],
  );
  return res.rows[0] ?? null;
}
