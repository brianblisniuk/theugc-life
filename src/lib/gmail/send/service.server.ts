import "server-only";

import type { GmailDeps } from "@/lib/gmail/connection.server";
import { getFreshGmailAccessToken, type AccessTokenOutcome } from "@/lib/gmail/connection.server";
import { GoogleAdapterError, type GoogleOAuthAdapter } from "@/lib/gmail/google.server";
import { assessSendGuard, dailyCapFromEnv, type SendGuardEnv } from "@/lib/gmail/send/guard";
import { MimeRejected, buildPlainMessage, encodeRawMessage } from "@/lib/gmail/send/mime";

export interface GmailSendInput {
  userId: string;
  mailAccountId: string;
  idempotencyKey: string;
  kind: "pitch" | "reply";
  recipient: string;
  subject: string;
  body: string;
  hotelId?: string | null;
  pipelineItemId?: string | null;
  tripId?: string | null;
  pitchDraftId?: string | null;
  providerThreadId?: string | null;
}

export type GmailSendOutcome =
  | {
      result: "sent";
      attemptId: string;
      eventId: string;
      providerMessageId: string;
      providerThreadId: string;
      bindingStatus: string;
    }
  | { result: "unknown"; attemptId: string | null }
  | { result: "failed"; attemptId: string | null; failureCode: string }
  | { result: "in_progress"; attemptId: string | null }
  | { result: "idempotency_conflict" }
  | { result: "invalid_input" }
  | { result: "not_found" };

export interface SendDeps {
  db: GmailDeps["db"];
  google: GoogleOAuthAdapter;
  env: SendGuardEnv & { dailyLimit?: string | null };
  getAccessToken?: (mailAccountId: string) => Promise<AccessTokenOutcome>;
}

type RpcRow = Record<string, unknown>;

const DEFINITE_PROVIDER_CODES = new Set([
  "token_revoked",
  "quota",
  "scope_missing",
  "provider_error",
  "not_connected",
  "mailbox_unusable",
  "plan_required",
]);

function str(row: RpcRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function callRpc(db: SendDeps["db"], fn: string, args: Record<string, unknown>): Promise<RpcRow> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error("gmail_send_rpc_failed");
  return (data ?? {}) as RpcRow;
}

function storedOutcome(row: RpcRow): GmailSendOutcome {
  const result = str(row, "result");
  const attemptId = str(row, "attempt_id");
  if (result === "sent") {
    return {
      result: "sent",
      attemptId: attemptId ?? "",
      eventId: str(row, "event_id") ?? "",
      providerMessageId: str(row, "provider_message_id") ?? "",
      providerThreadId: str(row, "provider_thread_id") ?? "",
      bindingStatus: str(row, "binding_status") ?? "not_requested",
    };
  }
  if (result === "unknown") return { result: "unknown", attemptId };
  if (result === "in_progress") return { result: "in_progress", attemptId };
  if (result === "idempotency_conflict") return { result: "idempotency_conflict" };
  if (result === "invalid_input") return { result: "invalid_input" };
  if (result === "not_found") return { result: "not_found" };
  if (result === "failed") {
    return { result: "failed", attemptId, failureCode: str(row, "failure_code") ?? "provider_error" };
  }
  return { result: "unknown", attemptId };
}

function tokenFailure(outcome: AccessTokenOutcome): string {
  if (outcome.result === "reauth_required") return "token_revoked";
  if (outcome.result === "not_connected") return "not_connected";
  if (outcome.result === "consent_missing") return "scope_missing";
  return "provider_error";
}

function providerFailure(error: unknown): "unknown" | string {
  if (error instanceof GoogleAdapterError && error.code === "gmail_send_transport") return "unknown";
  if (error instanceof GoogleAdapterError && DEFINITE_PROVIDER_CODES.has(error.code)) return error.code;
  if (error instanceof GoogleAdapterError && error.code === "gmail_send_blocked_in_test") {
    return "provider_error";
  }
  if (error instanceof MimeRejected) return "provider_error";
  return "unknown";
}

/**
 * One explicit send. The attempt row is committed before Gmail is called.
 * A repeated idempotency key does not call Gmail again. A transport error
 * after the call is stored as unknown.
 */
export async function sendGmailMessage(
  input: GmailSendInput,
  deps: SendDeps,
): Promise<GmailSendOutcome> {
  let reserved: RpcRow;
  try {
    reserved = await callRpc(deps.db, "gmail_send_reserve", {
      p_user_id: input.userId,
      p_mail_account_id: input.mailAccountId,
      p_idempotency_key: input.idempotencyKey,
      p_kind: input.kind,
      p_recipient: input.recipient,
      p_subject: input.subject,
      p_body: input.body,
      p_hotel_id: input.hotelId ?? null,
      p_pipeline_item_id: input.pipelineItemId ?? null,
      p_trip_id: input.tripId ?? null,
      p_pitch_draft_id: input.pitchDraftId ?? null,
      p_provider_thread_id: input.providerThreadId ?? null,
    });
  } catch {
    return { result: "unknown", attemptId: null };
  }

  if (reserved.call_provider !== true) return storedOutcome(reserved);

  const attemptId = str(reserved, "attempt_id");
  if (!attemptId) return { result: "unknown", attemptId: null };

  const guard = assessSendGuard(deps.env, str(reserved, "recipient") ?? input.recipient);
  if (!guard.ok) {
    return failAttempt(deps, input.userId, attemptId, guard.code);
  }

  const from = str(reserved, "from_email");
  const recipient = str(reserved, "recipient");
  const subject = str(reserved, "subject");
  const body = str(reserved, "body");
  if (!from || !recipient || !subject || !body) {
    return failAttempt(deps, input.userId, attemptId, "mailbox_unusable");
  }

  let raw: string;
  try {
    raw = encodeRawMessage(buildPlainMessage({ from, to: recipient, subject, body }));
  } catch {
    return failAttempt(deps, input.userId, attemptId, "provider_error");
  }

  let marked: RpcRow;
  try {
    marked = await callRpc(deps.db, "gmail_send_mark_provider", {
      p_user_id: input.userId,
      p_attempt_id: attemptId,
      p_daily_cap: dailyCapFromEnv(deps.env.dailyLimit),
    });
  } catch {
    return { result: "unknown", attemptId };
  }
  if (marked.call_provider !== true) return storedOutcome(marked);

  const token = deps.getAccessToken
    ? await deps.getAccessToken(str(reserved, "mail_account_id") ?? input.mailAccountId)
    : await getFreshGmailAccessToken(
        { mailAccountId: str(reserved, "mail_account_id") ?? input.mailAccountId },
        { db: deps.db, google: deps.google },
      );
  if (token.result !== "ok") {
    return failAttempt(deps, input.userId, attemptId, tokenFailure(token));
  }

  let sent: { id: string; threadId: string };
  try {
    sent = await deps.google.sendMessage({
      accessToken: token.accessToken,
      raw,
      threadId: str(reserved, "provider_thread_id"),
    });
  } catch (error) {
    const code = providerFailure(error);
    if (code === "unknown") return failAttempt(deps, input.userId, attemptId, "unknown");
    return failAttempt(deps, input.userId, attemptId, code);
  }

  if (!sent.id || !sent.threadId) {
    return failAttempt(deps, input.userId, attemptId, "unknown");
  }

  try {
    const committed = await callRpc(deps.db, "gmail_send_commit", {
      p_user_id: input.userId,
      p_attempt_id: attemptId,
      p_provider_message_id: sent.id,
      p_provider_thread_id: sent.threadId,
    });
    if (committed.result === "sent") return storedOutcome(committed);
    return failAttempt(deps, input.userId, attemptId, "unknown");
  } catch {
    return failAttempt(deps, input.userId, attemptId, "unknown");
  }
}

async function failAttempt(
  deps: SendDeps,
  userId: string,
  attemptId: string,
  code: string,
): Promise<GmailSendOutcome> {
  try {
    const failed = await callRpc(deps.db, "gmail_send_fail", {
      p_user_id: userId,
      p_attempt_id: attemptId,
      p_code: code,
    });
    return storedOutcome(failed);
  } catch {
    return { result: "unknown", attemptId };
  }
}
