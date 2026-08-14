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

import { getSessionContext } from "@/lib/auth/guards";

import { shouldRefreshIntelligence } from "@/lib/intelligence/refresh";

import { parseCollaborationForm, parseDealForm, parseWorkflowForm } from "./input";
import {
  progressCollaboration,
  progressPipelineDeal,
  refreshIntelligenceForPipelineItem,
  saveHotelToPipeline,
  transitionPipelineItem,
} from "./queries";
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
  // Identity comes ONLY from the session cookie.
  const session = await getSessionContext();
  if (!session) return { result: "error" };

  const hotelId = formData.get("hotelId");
  if (typeof hotelId !== "string") return { result: "error" };

  const result = await saveHotelToPipeline(session.userId, hotelId);

  if (isSaveSuccessful(result)) {
    // Reflect the new Saved state immediately on both surfaces.
    revalidatePath(`/app/hotels/${hotelId}`);
    revalidatePath("/app/pipeline");
  }

  return result;
}

/**
 * Workflow transition server action (PRD §7.4, EVENTS.md §3/§4).
 *
 * The browser posts only what the creator actually filled in. Identity comes
 * from the session cookie and the Free engaged allowance from typed server
 * config — neither is read from the form, so neither can be forged.
 */
export async function transitionPipelineItemAction(formData: FormData): Promise<TransitionResult> {
  const session = await getSessionContext();
  if (!session) return { result: "error" };

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
    // Both surfaces must reflect the new status and the new activity order.
    if (hotelId) revalidatePath(`/app/hotels/${hotelId}`);
    revalidatePath("/app/pipeline");
  }

  // Derived intelligence is refreshed AFTER the workflow committed, from the
  // item id (never the browser's hotel id), and its outcome is ignored: the
  // creator's event is already recorded, so a stale aggregate must not turn a
  // successful action into an error.
  if (shouldRefreshIntelligence(result)) {
    await refreshIntelligenceForPipelineItem(parsed.value.pipelineItemId);
  }

  return result;
}

/**
 * Deal-progress server action (PRD §7.4, EVENTS.md §3).
 *
 * Same boundary as the workflow action: the browser names an item and an
 * action and supplies the fields the creator filled in. Identity comes from
 * the session; the collaboration is created by the database alongside its
 * `deal_won` event, never by this layer.
 */
export async function progressPipelineDealAction(formData: FormData): Promise<DealResult> {
  const session = await getSessionContext();
  if (!session) return { result: "error" };

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

  // Same best-effort contract as the workflow action: the deal is recorded
  // whatever the aggregate does.
  if (shouldRefreshIntelligence(result)) {
    await refreshIntelligenceForPipelineItem(parsed.value.pipelineItemId);
  }

  return result;
}

/**
 * Collaboration lifecycle server action (PRD §7.4, D045).
 *
 * The browser names a pipeline item, an action, and the fields the creator
 * filled in. Identity comes from the session; the collaboration and the hotel
 * are resolved inside the database.
 */
export async function progressCollaborationAction(
  formData: FormData,
): Promise<CollaborationResult> {
  const session = await getSessionContext();
  if (!session) return { result: "error" };

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

  // `collaboration_started` and `collaboration_completed` are qualifying
  // activity events for 0022, so a successful lifecycle move refreshes the
  // derived intelligence — after the fact, from the item id, and with its
  // outcome ignored. `schedule` emits no event and needs no refresh.
  if (isCollaborationSuccessful(result) && parsed.value.action !== "schedule") {
    await refreshIntelligenceForPipelineItem(parsed.value.pipelineItemId);
  }

  return result;
}
