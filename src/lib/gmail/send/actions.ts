"use server";

/**
 * Send one pitch or reply from the signed-in creator's own Gmail (D156).
 *
 * The form does not post a user id. The session is the caller. A template
 * or an AI draft is not sent by saving or copying it. This action is the
 * only send.
 */
import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { googleOAuthAdapter } from "@/lib/gmail/google.server";
import { createAdminClient } from "@/lib/supabase/admin";

import { SUPPORT_EMAIL } from "@/lib/support";

import { sendGuardFromProcess } from "./guard";
import { sendGmailMessage, type GmailSendOutcome } from "./service.server";

bindServerActions(["gmail.send"]);

export type SendPitchResult =
  | {
      result: "sent";
      message: string;
      retry: false;
    }
  | { result: "unknown"; message: string; retry: false }
  | { result: "failed"; failureCode: string; message: string; retry: boolean }
  | { result: "queued"; message: string; retry: false }
  | { result: "paused"; message: string; retry: false }
  | { result: "in_progress"; message: string; retry: false }
  | { result: "idempotency_conflict"; message: string; retry: false }
  | { result: "invalid_input"; message: string; retry: true }
  | { result: "not_found"; message: string; retry: true }
  | { result: "signed_out"; message: string; retry: false };

const NO_RETRY = new Set(["unknown", "sent", "in_progress", "deletion_pending"]);

function readRaw(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function readField(formData: FormData, name: string): string {
  return readRaw(formData, name).trim();
}

function optionalId(value: string): string | null {
  return value.length > 0 ? value : null;
}

function messageFor(outcome: GmailSendOutcome): SendPitchResult {
  if (outcome.result === "sent") {
    return {
      result: "sent",
      retry: false,
      message: "Sent from your Gmail. The hotel is not marked as pitched.",
    };
  }
  if (outcome.result === "unknown") {
    return {
      result: "unknown",
      retry: false,
      message: "Gmail may have received the message. It will not be sent again from this button.",
    };
  }
  if (outcome.result === "queued") {
    return {
      result: "queued",
      retry: false,
      message:
        "Queued. It will send during your business hours, a few minutes apart. The hotel is not marked as pitched.",
    };
  }
  if (outcome.result === "paused") {
    const reason =
      outcome.pause === "sends"
        ? "Sending is paused because too many recent messages bounced."
        : "AI and sending are paused on this account.";
    return {
      result: "paused",
      retry: false,
      message: `${reason} Email ${SUPPORT_EMAIL} and we'll review it.`,
    };
  }
  if (outcome.result === "deferred") {
    return {
      result: "queued",
      retry: false,
      message: "Queued for the next business day. The hotel is not marked as pitched.",
    };
  }
  if (outcome.result === "in_progress") {
    return { result: "in_progress", retry: false, message: "That send is already in progress." };
  }
  if (outcome.result === "idempotency_conflict") {
    return {
      result: "idempotency_conflict",
      retry: false,
      message: "This send doesn't match the one already recorded.",
    };
  }
  if (outcome.result === "invalid_input") {
    return {
      result: "invalid_input",
      retry: true,
      message: "Check the subject, message, and address.",
    };
  }
  if (outcome.result === "not_found") {
    return { result: "not_found", retry: true, message: "That mailbox or hotel isn't available." };
  }
  const code = outcome.failureCode;
  const copy: Record<string, string> = {
    plan_required: "Sending from Gmail is included with Pro.",
    scope_missing: "Allow sending from this Gmail account, then try again.",
    not_connected: "Connect Gmail before sending.",
    token_revoked: "Gmail needs to be reconnected before this can send.",
    quota: "Gmail refused this send because of a quota. It was not sent again.",
    rate_limited: "Wait a moment before another send.",
    allowlist: "This address isn't allowed in this environment.",
    kill_switch: "Sending is turned off.",
    provider_error: "Gmail didn't accept the message. It was not sent.",
    invalid_recipient: "That address isn't a contact on this hotel.",
    mailbox_unusable: "This mailbox can't send.",
    deletion_pending: "Account deletion is pending, so this was not sent.",
  };
  return {
    result: "failed",
    failureCode: code,
    retry: !NO_RETRY.has(code),
    message: copy[code] ?? "The message was not sent.",
  };
}

export async function sendPitchFromGmailAction(formData: FormData): Promise<SendPitchResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") {
    return { result: "signed_out", retry: false, message: "Sign in to send." };
  }

  const kind = readField(formData, "kind") === "reply" ? "reply" : "pitch";
  const outcome = await sendGmailMessage(
    {
      userId: resolution.session.userId,
      mailAccountId: readField(formData, "mailAccountId"),
      idempotencyKey: readField(formData, "idempotencyKey"),
      kind,
      recipient: readField(formData, "recipient"),
      subject: readField(formData, "subject"),
      body: readRaw(formData, "body"),
      hotelId: optionalId(readField(formData, "hotelId")),
      tripId: optionalId(readField(formData, "tripId")),
      pitchDraftId: optionalId(readField(formData, "draftId")),
      pipelineItemId: optionalId(readField(formData, "pipelineItemId")),
    },
    {
      db: createAdminClient(),
      google: googleOAuthAdapter,
      env: sendGuardFromProcess(),
    },
  );
  return messageFor(outcome);
}
