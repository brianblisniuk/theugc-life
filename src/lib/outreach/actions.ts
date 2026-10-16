"use server";

/**
 * Outreach actions (D184, D182).
 *
 * The form posts a name, a trip, a hotel, or dates. It does not post a user
 * id. Opening an opportunity is a separate action from adding a hotel.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { parseStayPair, parseTripId } from "@/lib/trips/input";

bindServerActions(["outreach.own", "pipeline.save"]);

import {
  addCampaignHotel,
  createCampaign,
  deleteCampaign,
  importShortlist,
  openOpportunity,
  setOpportunityDates,
} from "./queries";
import type { OpenOpportunityResult, OpportunityDatesResult, OutreachWriteResult } from "./types";

function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function optionalId(value: string | null): string | null | undefined {
  if (!value || !value.trim()) return null;
  return parseTripId(value);
}

export async function createOutreachAction(formData: FormData): Promise<OutreachWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const name = readField(formData, "name")?.trim() ?? "";
  if (!name || name.length > 120) return { result: "invalid_input" };
  const tripId = optionalId(readField(formData, "tripId"));
  const destinationId = optionalId(readField(formData, "destinationId"));
  if (tripId === undefined || destinationId === undefined) return { result: "invalid_input" };

  const result = await createCampaign(resolution.session.userId, {
    name,
    tripId,
    destinationId: tripId ? null : destinationId,
  });
  if (result.result === "created") {
    revalidatePath("/app/outreach");
    revalidatePath("/app/trips");
    if (tripId) revalidatePath(`/app/trips/${tripId}`);
  }
  return result;
}

export async function importOutreachShortlistAction(
  formData: FormData,
): Promise<OutreachWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const initiativeId = parseTripId(readField(formData, "initiativeId"));
  if (!initiativeId) return { result: "invalid_input" };
  const result = await importShortlist(resolution.session.userId, initiativeId);
  if (result.result === "imported") revalidatePath(`/app/outreach/${initiativeId}`);
  return result;
}

export async function addOutreachHotelAction(formData: FormData): Promise<OutreachWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const initiativeId = parseTripId(readField(formData, "initiativeId"));
  const hotelId = parseTripId(readField(formData, "hotelId"));
  if (!initiativeId || !hotelId) return { result: "invalid_input" };
  const result = await addCampaignHotel(resolution.session.userId, initiativeId, hotelId);
  if (result.result === "added" || result.result === "already_linked") {
    revalidatePath(`/app/outreach/${initiativeId}`);
  }
  return result;
}

export async function deleteOutreachAction(formData: FormData): Promise<OutreachWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const initiativeId = parseTripId(readField(formData, "initiativeId"));
  if (!initiativeId) return { result: "invalid_input" };
  const result = await deleteCampaign(resolution.session.userId, initiativeId);
  if (result.result === "deleted") {
    revalidatePath("/app/outreach");
    redirect("/app/outreach");
  }
  return result;
}

export async function openOutreachOpportunityAction(
  formData: FormData,
): Promise<OpenOpportunityResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const hotelId = parseTripId(readField(formData, "hotelId"));
  const tripId = optionalId(readField(formData, "tripId"));
  const initiativeId = optionalId(readField(formData, "initiativeId"));
  const dates = parseStayPair(readField(formData, "stayStart"), readField(formData, "stayEnd"));
  if (!hotelId || tripId === undefined || initiativeId === undefined || !dates.ok) {
    return { result: "invalid_input" };
  }
  const result = await openOpportunity(resolution.session.userId, {
    hotelId,
    tripId,
    initiativeId,
    stayStart: dates.checkIn,
    stayEnd: dates.checkOut,
  });
  if (result.result === "created" || result.result === "already_open") {
    if (initiativeId) revalidatePath(`/app/outreach/${initiativeId}`);
    if (tripId) revalidatePath(`/app/trips/${tripId}`);
    revalidatePath("/app/outreach");
    revalidatePath("/app/pipeline");
  }
  return result;
}

export async function setOpportunityDatesAction(
  formData: FormData,
): Promise<OpportunityDatesResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const pipelineItemId = parseTripId(readField(formData, "pipelineItemId"));
  const tripId = optionalId(readField(formData, "tripId"));
  const initiativeId = optionalId(readField(formData, "initiativeId"));
  const dates = parseStayPair(readField(formData, "stayStart"), readField(formData, "stayEnd"));
  if (!pipelineItemId || tripId === undefined || initiativeId === undefined || !dates.ok) {
    return { result: "invalid_input" };
  }
  const result = await setOpportunityDates(
    resolution.session.userId,
    pipelineItemId,
    dates.checkIn,
    dates.checkOut,
  );
  if (result.result === "updated") {
    if (tripId) revalidatePath(`/app/trips/${tripId}`);
    if (initiativeId) revalidatePath(`/app/outreach/${initiativeId}`);
  }
  return result;
}
