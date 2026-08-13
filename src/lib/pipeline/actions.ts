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

import { parseWorkflowForm } from "./input";
import { saveHotelToPipeline, transitionPipelineItem } from "./queries";
import {
  isSaveSuccessful,
  isTransitionSuccessful,
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

  return result;
}
