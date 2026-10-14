"use server";

/**
 * Schedule or cancel one follow-up on a pitch this creator already sent.
 *
 * The form does not post a user id. The recipient is not posted: the
 * database copies it from the sent pitch. Drafting text does not schedule
 * it. This action does not call Gmail.
 */

import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { isUuid } from "@/lib/hotels/ids";
import { createAdminClient } from "@/lib/supabase/admin";

bindServerActions(["gmail.send"]);

export type FollowUpActionResult =
  | { result: "scheduled"; message: string }
  | { result: "cancelled"; message: string }
  | { result: "stopped"; message: string }
  | { result: "plan_required"; message: string }
  | { result: "recipient_rejected"; message: string }
  | { result: "limit_reached"; message: string }
  | { result: "text_conflict"; message: string }
  | { result: "not_found"; message: string }
  | { result: "invalid_input"; message: string }
  | { result: "in_progress"; message: string }
  | { result: "signed_out"; message: string }
  | { result: "error"; message: string };

function readRaw(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function hotelPath(hotelId: string): string {
  return `/app/hotels/${hotelId}/pitch`;
}

export async function scheduleFollowUpAction(formData: FormData): Promise<FollowUpActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") {
    return { result: "signed_out", message: "Sign in to schedule a follow-up." };
  }
  const hotelId = readRaw(formData, "hotelId").trim();
  const eventId = readRaw(formData, "eventId").trim();
  const subject = readRaw(formData, "subject").trim();
  const body = readRaw(formData, "body");
  if (!isUuid(hotelId) || !isUuid(eventId)) {
    return { result: "invalid_input", message: "Choose a pitch you already sent." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("gmail_followup_schedule", {
    p_user_id: resolution.session.userId,
    p_event_id: eventId,
    p_subject: subject,
    p_body: body,
  });
  if (error || !data || typeof data !== "object") {
    return { result: "error", message: "The follow-up could not be scheduled." };
  }
  const result = (data as { result?: unknown }).result;
  revalidatePath(hotelPath(hotelId));

  if (result === "scheduled" || result === "already_scheduled") {
    return {
      result: "scheduled",
      message: "Scheduled. It will not send before the time shown, and only the text above.",
    };
  }
  if (result === "plan_required") {
    return { result: "plan_required", message: "Follow-ups from Gmail are included with Pro." };
  }
  if (result === "recipient_rejected") {
    return {
      result: "recipient_rejected",
      message: "That address is no longer a contact on this hotel, so it was not scheduled.",
    };
  }
  if (result === "limit_reached") {
    return { result: "limit_reached", message: "This thread already has two follow-ups." };
  }
  if (result === "text_conflict") {
    return {
      result: "text_conflict",
      message: "A follow-up is already scheduled. Cancel it before scheduling different text.",
    };
  }
  if (result === "stopped") {
    return {
      result: "stopped",
      message: "This thread is stopped, so the follow-up was not scheduled.",
    };
  }
  if (result === "invalid_input") {
    return { result: "invalid_input", message: "Check the subject and the message." };
  }
  if (result === "not_found" || result === "not_ready") {
    return { result: "not_found", message: "That sent pitch isn't available for a follow-up." };
  }
  return { result: "error", message: "The follow-up could not be scheduled." };
}

export async function cancelFollowUpAction(formData: FormData): Promise<FollowUpActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") {
    return { result: "signed_out", message: "Sign in to cancel a follow-up." };
  }
  const hotelId = readRaw(formData, "hotelId").trim();
  const followupId = readRaw(formData, "followupId").trim();
  if (!isUuid(hotelId) || !isUuid(followupId)) {
    return { result: "invalid_input", message: "Choose the follow-up to cancel." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("gmail_followup_cancel", {
    p_user_id: resolution.session.userId,
    p_followup_id: followupId,
  });
  if (error || !data || typeof data !== "object") {
    return { result: "error", message: "The follow-up could not be cancelled." };
  }
  revalidatePath(hotelPath(hotelId));
  const result = (data as { result?: unknown }).result;
  if (result === "cancelled") {
    return { result: "cancelled", message: "Cancelled. It will not send." };
  }
  if (result === "in_progress") {
    return {
      result: "in_progress",
      message: "Gmail may already be sending this. It was not cancelled.",
    };
  }
  if (result === "sent") {
    return { result: "stopped", message: "That follow-up was already sent." };
  }
  if (result === "not_found") {
    return { result: "not_found", message: "That follow-up isn't on your account." };
  }
  return { result: "error", message: "The follow-up could not be cancelled." };
}
