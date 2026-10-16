"use server";

/**
 * Save-to-Pipeline server action (PRD §7.3, PERMISSIONS.md §5).
 *
 * The browser never calls the privileged RPC. It posts a hotel id; identity is
 * resolved here from the authenticated session, so a forged `creator_id` or
 * `user_id` field is impossible — those inputs are not read at all.
 *
 * The returned value is a typed, sanitized result; no SQL or driver text is
 * ever sent to the client.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";

// Load-time binding. A "use server" module may export only async functions.
bindServerActions(["pipeline.save", "pipeline.engage", "pipeline.own", "collaborations.lifecycle"]);

import { shouldRefreshIntelligence } from "@/lib/intelligence/refresh";
import { recordCreatorFitDecision } from "@/lib/intelligence/queries";
import { recordNetworkPriority } from "@/lib/network-intelligence/queries";

import { parseCollaborationForm, parseDealForm, parseWorkflowForm } from "./input";
import {
  progressCollaboration,
  progressPipelineDeal,
  refreshIntelligenceForPipelineItem,
  saveHotelToPipeline,
  transitionPipelineItem,
} from "./queries";
import { updatePipelinePrivateNotes } from "./notes";
import {
  isCollaborationSuccessful,
  isDealSuccessful,
  isSaveSuccessful,
  isTransitionSuccessful,
  type CollaborationResult,
  type DealResult,
  type SaveResult,
  type TransitionResult,
} from "./types";

/** Only string form fields are ever read; anything else is treated as absent. */
function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

export async function saveHotelAction(formData: FormData): Promise<SaveResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const session = resolution.session;

  const hotelId = formData.get("hotelId");
  if (typeof hotelId !== "string") return { result: "error" };

  const result = await saveHotelToPipeline(session.userId, hotelId);

  if (isSaveSuccessful(result)) {
    revalidatePath(`/app/hotels/${hotelId}`);
    revalidatePath("/app/pipeline");
  }

  return result;
}

export async function transitionPipelineItemAction(formData: FormData): Promise<TransitionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const session = resolution.session;

  const parsed = parseWorkflowForm({
    pipelineItemId: readField(formData, "pipelineItemId"),
    action: readField(formData, "action"),
    eventAt: readField(formData, "eventAt"),
    channel: readField(formData, "channel"),
    sentiment: readField(formData, "sentiment"),
    offerType: readField(formData, "offerType"),
    closeReason: readField(formData, "closeReason"),
  });
  if (!parsed.ok) return { result: "invalid_input" };

  const hotelId = readField(formData, "hotelId");
  const result = await transitionPipelineItem(session.userId, parsed.value);

  if (isTransitionSuccessful(result)) {
    if (hotelId) revalidatePath(`/app/hotels/${hotelId}`);
    revalidatePath("/app/pipeline");
  }

  if (shouldRefreshIntelligence(result)) {
    await refreshIntelligenceForPipelineItem(parsed.value.pipelineItemId);
  }

  return result;
}

export async function progressPipelineDealAction(formData: FormData): Promise<DealResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const session = resolution.session;

  const parsed = parseDealForm({
    pipelineItemId: readField(formData, "pipelineItemId"),
    action: readField(formData, "action"),
    eventAt: readField(formData, "eventAt"),
    collaborationType: readField(formData, "collaborationType"),
  });
  if (!parsed.ok) return { result: "invalid_input" };

  const hotelId = readField(formData, "hotelId");
  const result = await progressPipelineDeal(session.userId, parsed.value);

  if (isDealSuccessful(result)) {
    if (hotelId) revalidatePath(`/app/hotels/${hotelId}`);
    revalidatePath("/app/pipeline");
  }

  if (shouldRefreshIntelligence(result)) {
    await refreshIntelligenceForPipelineItem(parsed.value.pipelineItemId);
  }

  return result;
}

export async function progressCollaborationAction(
  formData: FormData,
): Promise<CollaborationResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const session = resolution.session;

  const parsed = parseCollaborationForm({
    pipelineItemId: readField(formData, "pipelineItemId"),
    action: readField(formData, "action"),
    eventAt: readField(formData, "eventAt"),
    startDate: readField(formData, "startDate"),
    endDate: readField(formData, "endDate"),
    termsMatched: readField(formData, "termsMatched"),
    wouldWorkAgain: readField(formData, "wouldWorkAgain"),
    cancelReason: readField(formData, "cancelReason"),
  });
  if (!parsed.ok) return { result: "invalid_input" };

  const hotelId = readField(formData, "hotelId");
  const result = await progressCollaboration(session.userId, parsed.value);

  if (isCollaborationSuccessful(result)) {
    if (hotelId) revalidatePath(`/app/hotels/${hotelId}`);
    revalidatePath("/app/pipeline");
  }

  if (isCollaborationSuccessful(result) && parsed.value.action !== "schedule") {
    await refreshIntelligenceForPipelineItem(parsed.value.pipelineItemId);
  }

  return result;
}

/**
 * D095. Saves the hotel, then opens it. The redirect runs only after the
 * pipeline row exists. A failed save stays on the form and does not toast.
 */
export async function saveOnboardingHotelAction(formData: FormData): Promise<SaveResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const hotelId = formData.get("hotelId");
  if (typeof hotelId !== "string") return { result: "error" };
  const result = await saveHotelToPipeline(resolution.session.userId, hotelId);
  if (!isSaveSuccessful(result)) return result;
  revalidatePath(`/app/hotels/${hotelId}`);
  revalidatePath("/app/pipeline");
  revalidatePath("/app");
  redirect(`/app/hotels/${hotelId}?from=pipeline&notice=first-hotel`);
}

export async function updatePipelineNotesAction(formData: FormData): Promise<{
  result: "updated" | "preserved" | "error" | "not_found_or_forbidden" | "invalid_input";
}> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const session = resolution.session;

  const pipelineItemId = readField(formData, "pipelineItemId");
  const notes = readField(formData, "notes") ?? "";
  if (!pipelineItemId) return { result: "invalid_input" };
  const explicitClear = readField(formData, "clearNotes") === "1";

  const result = await updatePipelinePrivateNotes(
    session.userId,
    pipelineItemId,
    notes,
    explicitClear,
  );
  if (result.result === "updated") {
    revalidatePath("/app/pipeline");
  }
  return result;
}

export async function recordNetworkPriorityAction(formData: FormData): Promise<void> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return;
  const hotelId = readField(formData, "hotelId");
  if (!hotelId) return;
  const result = await recordNetworkPriority(hotelId);
  if (result.result === "ok") revalidatePath(`/app/hotels/${hotelId}`);
}

export async function recordCreatorFitDecisionAction(formData: FormData): Promise<void> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return;
  const hotelId = readField(formData, "hotelId");
  const decision = readField(formData, "decision");
  if (!hotelId || (decision !== "pursue" && decision !== "skip")) return;
  const result = await recordCreatorFitDecision(hotelId, decision);
  if (result.result === "ok") revalidatePath(`/app/hotels/${hotelId}`);
}
