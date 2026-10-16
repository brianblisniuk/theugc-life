"use server";

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { refreshCollaborationByProviderThread } from "@/lib/gmail/collaboration/queries";
import { answerGmailNetworkReading } from "@/lib/network-intelligence/queries";

// Load-time binding. A "use server" module may export only async functions.
bindServerActions(["inbox.own"]);

import { REPLY_SENTIMENTS, type InboxWriteResult } from "./contract";
import {
  acceptInboxSuggestion,
  bindInboxThread,
  dismissInboxSuggestion,
  unbindInboxThread,
} from "./queries";

function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function revalidate(hotelId: string | null) {
  if (hotelId) revalidatePath(`/app/hotels/${hotelId}`);
  revalidatePath("/app/pipeline");
  revalidatePath("/app/inbox");
}

export async function bindInboxThreadAction(formData: FormData): Promise<InboxWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  const mailAccountId = readField(formData, "mailAccountId");
  const providerThreadId = readField(formData, "providerThreadId")?.trim() ?? "";
  if (!pipelineItemId || !mailAccountId || !providerThreadId) return { result: "invalid_input" };
  const result = await bindInboxThread(
    resolution.session.userId,
    pipelineItemId,
    mailAccountId,
    providerThreadId,
  );
  if (
    result.result === "refreshed" ||
    result.result === "no_reading" ||
    result.result === "stale" ||
    result.result === "already_bound"
  ) {
    try {
      await refreshCollaborationByProviderThread(
        resolution.session.userId,
        mailAccountId,
        providerThreadId,
      );
    } catch (error) {
      console.error("[gmail] collaboration detection failed after linking a thread", error);
    }
    revalidate(readField(formData, "hotelId"));
  }
  return result;
}

export async function unbindInboxThreadAction(formData: FormData): Promise<InboxWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  if (!pipelineItemId) return { result: "invalid_input" };
  const result = await unbindInboxThread(resolution.session.userId, pipelineItemId);
  if (result.result === "unbound") revalidate(readField(formData, "hotelId"));
  return result;
}

export async function dismissInboxSuggestionAction(formData: FormData): Promise<InboxWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  const suggestionId = readField(formData, "suggestionId");
  if (!pipelineItemId || !suggestionId) return { result: "invalid_input" };
  const result = await dismissInboxSuggestion(
    resolution.session.userId,
    pipelineItemId,
    suggestionId,
  );
  if (result.result === "dismissed") revalidate(readField(formData, "hotelId"));
  return result;
}

export async function acceptInboxSuggestionAction(formData: FormData): Promise<InboxWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  const suggestionId = readField(formData, "suggestionId");
  const kind = readField(formData, "kind");
  if (!pipelineItemId || !suggestionId || !kind) return { result: "invalid_input" };

  let sentiment: string | null = null;
  if (kind === "mark_replied") {
    sentiment = readField(formData, "sentiment");
    if (!sentiment || !(REPLY_SENTIMENTS as readonly string[]).includes(sentiment)) {
      return { result: "invalid_input" };
    }
  }

  const date = readField(formData, "eventDate");
  let eventAt: string | null = null;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { result: "invalid_input" };
    eventAt = `${date}T00:00:00.000Z`;
  }

  const result = await acceptInboxSuggestion(
    resolution.session.userId,
    pipelineItemId,
    suggestionId,
    sentiment,
    eventAt,
  );
  if (
    result.result === "applied" ||
    result.result === "already_applied" ||
    result.result === "acknowledged"
  ) {
    revalidate(readField(formData, "hotelId"));
  }
  return result;
}

export async function answerGmailReadingAction(formData: FormData): Promise<{ result: string }> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  const decision = readField(formData, "decision");
  if (!pipelineItemId || (decision !== "confirmed" && decision !== "dismissed")) {
    return { result: "invalid_input" };
  }
  const result = await answerGmailNetworkReading(pipelineItemId, decision);
  if (
    result.result === "confirmed_admitted" ||
    result.result === "confirmed_not_admitted" ||
    result.result === "dismissed" ||
    result.result === "already_answered"
  ) {
    revalidate(readField(formData, "hotelId"));
  }
  return result;
}
