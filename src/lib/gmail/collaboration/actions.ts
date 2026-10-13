"use server";

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";

bindServerActions(["gmail.collaboration_detection"]);

import { REPLY_SENTIMENTS } from "@/lib/inbox-pipeline/contract";

import { confirmCollaborationSuggestion, dismissCollaborationSuggestion } from "./queries";

function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function revalidate(hotelId: string | null) {
  if (hotelId) revalidatePath(`/app/hotels/${hotelId}`);
  revalidatePath("/app/pipeline");
}

export async function confirmCollaborationSuggestionAction(
  formData: FormData,
): Promise<{ result: string; kind: string | null }> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error", kind: null };
  const pipelineItemId = readField(formData, "pipelineItemId");
  const suggestionId = readField(formData, "suggestionId");
  const kind = readField(formData, "kind");
  if (!pipelineItemId || !suggestionId || !kind) return { result: "invalid_input", kind };

  let sentiment: string | null = null;
  if (kind === "human_reply") {
    sentiment = readField(formData, "sentiment");
    if (!sentiment || !(REPLY_SENTIMENTS as readonly string[]).includes(sentiment)) {
      return { result: "invalid_input", kind };
    }
  }

  const result = await confirmCollaborationSuggestion(
    resolution.session.userId,
    pipelineItemId,
    suggestionId,
    sentiment,
  );
  if (
    result.result === "applied" ||
    result.result === "confirmed" ||
    result.result === "manual_overrides" ||
    result.result === "already_applied"
  ) {
    revalidate(readField(formData, "hotelId"));
  }
  return result;
}

export async function dismissCollaborationSuggestionAction(
  formData: FormData,
): Promise<{ result: string }> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = readField(formData, "pipelineItemId");
  const suggestionId = readField(formData, "suggestionId");
  if (!pipelineItemId || !suggestionId) return { result: "invalid_input" };
  const result = await dismissCollaborationSuggestion(
    resolution.session.userId,
    pipelineItemId,
    suggestionId,
  );
  if (result.result === "dismissed") revalidate(readField(formData, "hotelId"));
  return result;
}
