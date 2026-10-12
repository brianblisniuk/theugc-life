"use server";

/**
 * Trip server actions (PRD §7.5).
 *
 * The browser posts destination, dates, status, a hotel id or a pipeline item
 * id. It does not post a user id. The session is resolved here, and the RPCs
 * re-derive the creator profile.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";

export const TRIP_ENTITLEMENTS = bindServerActions(["trips.active", "trips.own"]);

import { parseTripForm, parseTripId } from "./input";
import {
  addTripHotel,
  createTrip,
  deleteTrip,
  linkPipelineItem,
  removeTripHotel,
  updateTrip,
} from "./queries";
import type { LinkResult, ShortlistResult, TripWriteResult } from "./types";

function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

export async function createTripAction(formData: FormData): Promise<TripWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const parsed = parseTripForm({
    destinationId: readField(formData, "destinationId"),
    name: readField(formData, "name"),
    startDate: readField(formData, "startDate"),
    endDate: readField(formData, "endDate"),
    status: readField(formData, "status"),
  });
  if (!parsed.ok) return { result: "invalid_input" };

  const result = await createTrip(resolution.session.userId, parsed.value);
  if (result.result === "created") {
    revalidatePath("/app/trips");
  }
  return result;
}

export async function updateTripAction(formData: FormData): Promise<TripWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const tripId = parseTripId(readField(formData, "tripId"));
  if (!tripId) return { result: "invalid_input" };

  const parsed = parseTripForm({
    destinationId: readField(formData, "destinationId"),
    name: readField(formData, "name"),
    startDate: readField(formData, "startDate"),
    endDate: readField(formData, "endDate"),
    status: readField(formData, "status"),
  });
  if (!parsed.ok) return { result: "invalid_input" };

  const result = await updateTrip(resolution.session.userId, tripId, parsed.value);
  if (result.result === "updated") {
    revalidatePath("/app/trips");
    revalidatePath(`/app/trips/${tripId}`);
  }
  return result;
}

export async function deleteTripAction(formData: FormData): Promise<TripWriteResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const tripId = parseTripId(readField(formData, "tripId"));
  if (!tripId) return { result: "invalid_input" };

  const result = await deleteTrip(resolution.session.userId, tripId);
  if (result.result === "deleted") {
    revalidatePath("/app/trips");
    redirect("/app/trips");
  }
  return result;
}

export async function addTripHotelAction(formData: FormData): Promise<ShortlistResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const tripId = parseTripId(readField(formData, "tripId"));
  const hotelId = parseTripId(readField(formData, "hotelId"));
  if (!tripId || !hotelId) return { result: "invalid_input" };

  const result = await addTripHotel(resolution.session.userId, tripId, hotelId);
  if (result.result === "added" || result.result === "already_shortlisted") {
    revalidatePath(`/app/trips/${tripId}`);
    revalidatePath(`/app/hotels/${hotelId}`);
    revalidatePath("/app/discover");
  }
  return result;
}

export async function removeTripHotelAction(formData: FormData): Promise<ShortlistResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const tripId = parseTripId(readField(formData, "tripId"));
  const hotelId = parseTripId(readField(formData, "hotelId"));
  if (!tripId || !hotelId) return { result: "invalid_input" };

  const result = await removeTripHotel(resolution.session.userId, tripId, hotelId);
  if (result.result === "removed") revalidatePath(`/app/trips/${tripId}`);
  return result;
}

export async function linkPipelineItemAction(formData: FormData): Promise<LinkResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const tripId = parseTripId(readField(formData, "tripId"));
  const pipelineItemId = parseTripId(readField(formData, "pipelineItemId"));
  const mode = readField(formData, "mode");
  if (!tripId || !pipelineItemId || (mode !== "link" && mode !== "unlink")) {
    return { result: "invalid_input" };
  }

  const result = await linkPipelineItem(
    resolution.session.userId,
    pipelineItemId,
    mode === "link" ? tripId : null,
  );
  if (result.result === "linked" || result.result === "unlinked") {
    revalidatePath(`/app/trips/${tripId}`);
  }
  return result;
}
