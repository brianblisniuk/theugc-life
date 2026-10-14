import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import {
  FOLLOW_UP_HOLDS,
  FOLLOW_UP_STOP_REASONS,
  type FollowUpHold,
  type FollowUpItem,
  type FollowUpNext,
  type FollowUpState,
  type FollowUpStopReason,
} from "./next-action";

export type { FollowUpItem };

export interface FollowUpThread {
  eventId: string;
  providerThreadId: string;
  recipient: string;
  originalSubject: string;
  sentAt: string | null;
  pipelineStatus: string | null;
  followups: FollowUpItem[];
  next: FollowUpNext;
}

export type FollowUpLoad =
  { status: "ok"; threads: FollowUpThread[]; timeZone: string } | { status: "error" };

const STATES = new Set<FollowUpState>([
  "needs_opt_in",
  "scheduled",
  "queued",
  "held",
  "stopped",
  "complete",
]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stopReason(value: unknown): FollowUpStopReason | null {
  return typeof value === "string" && FOLLOW_UP_STOP_REASONS.includes(value as FollowUpStopReason)
    ? (value as FollowUpStopReason)
    : null;
}

function hold(value: unknown): FollowUpHold | null {
  return typeof value === "string" && FOLLOW_UP_HOLDS.includes(value as FollowUpHold)
    ? (value as FollowUpHold)
    : null;
}

function sequence(value: unknown): 1 | 2 | null {
  if (value === 1 || value === 2) return value;
  return null;
}

function parseNext(value: unknown, recipient: string): FollowUpNext | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const state = row.state;
  if (typeof state !== "string" || !STATES.has(state as FollowUpState)) return null;
  return {
    state: state as FollowUpState,
    sequence: sequence(row.sequence),
    followupId: text(row.followup_id),
    recipient: text(row.recipient) ?? recipient,
    subject: text(row.subject),
    body: typeof row.body === "string" && row.body.length > 0 ? row.body : null,
    earliestSendAt: text(row.earliest_send_at),
    stopReason: stopReason(row.stop_reason),
    hold: hold(row.hold),
  };
}

function parseThread(value: unknown): FollowUpThread | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const eventId = text(row.event_id);
  const recipient = text(row.recipient);
  if (!eventId || !recipient) return null;
  const next = parseNext(row.next, recipient);
  if (!next) return null;
  const followups: FollowUpItem[] = [];
  if (Array.isArray(row.followups)) {
    for (const item of row.followups) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = text(record.id);
      const seq = sequence(record.sequence);
      const subject = typeof record.subject === "string" ? record.subject : null;
      const body = typeof record.body === "string" ? record.body : null;
      if (!id || !seq || subject === null || body === null) continue;
      followups.push({
        id,
        sequence: seq,
        status: text(record.status) ?? "scheduled",
        stopReason: stopReason(record.stop_reason),
        subject,
        body,
        recipient: text(record.recipient) ?? recipient,
        earliestSendAt: text(record.earliest_send_at),
      });
    }
  }
  return {
    eventId,
    providerThreadId: text(row.provider_thread_id) ?? "",
    recipient,
    originalSubject: typeof row.original_subject === "string" ? row.original_subject : "",
    sentAt: text(row.sent_at),
    pipelineStatus: text(row.pipeline_status),
    followups,
    next,
  };
}

export async function loadHotelFollowUps(userId: string, hotelId: string): Promise<FollowUpLoad> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("gmail_followup_list_for_hotel", {
    p_user_id: userId,
    p_hotel_id: hotelId,
  });
  if (error || !data || typeof data !== "object") return { status: "error" };
  const row = data as { result?: unknown; threads?: unknown };
  if (row.result !== "ok" || !Array.isArray(row.threads)) return { status: "error" };
  const timeZone = text((data as { timezone?: unknown }).timezone) ?? "UTC";
  const threads: FollowUpThread[] = [];
  for (const thread of row.threads) {
    const parsed = parseThread(thread);
    if (!parsed) return { status: "error" };
    threads.push(parsed);
  }
  return { status: "ok", threads, timeZone };
}
