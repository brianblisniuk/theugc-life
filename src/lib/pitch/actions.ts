"use server";

/**
 * Pitch writes for the signed-in creator (D110).
 *
 * The form does not post a user id. The session is the caller, and the
 * database guard sets creator_id. These actions do not send mail and do not
 * write the outreach ledger or pipeline status.
 */
import { revalidatePath } from "next/cache";

import { resolveSession } from "@/lib/auth/guards";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { getHotelById } from "@/lib/hotels/queries";
import { createClient } from "@/lib/supabase/server";

import {
  FACT_KEYS,
  parseDelivery,
  parsePitchDraftFields,
  parsePitchTemplateFields,
  type FactKey,
} from "./contract";
import { loadPitchContext } from "./queries";
import { pitchTripToStore, resolveOpportunityDraftWrite } from "./studio";

bindServerActions(["pitch.drafts"]);

export type PitchActionResult =
  | { result: "saved"; draftId?: string }
  | { result: "archived" }
  | { result: "recorded" }
  | { result: "invalid_input"; message: string }
  | { result: "not_found" }
  | { result: "error" };

function readField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function factKeys(facts: Partial<Record<FactKey, string>>): FactKey[] {
  return FACT_KEYS.filter((key) => Boolean(facts[key]));
}

export async function savePitchTemplateAction(formData: FormData): Promise<PitchActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const parsed = parsePitchTemplateFields({
    name: readField(formData, "name"),
    subject: readField(formData, "subject"),
    body: readField(formData, "body"),
  });
  if (!parsed.ok) return { result: "invalid_input", message: parsed.message };

  try {
    const supabase = await createClient();
    const { error } = await supabase.from("pitch_templates").insert({
      name: parsed.name,
      subject: parsed.subject,
      body: parsed.body,
    });
    if (error) return { result: "error" };
    revalidatePath("/app/profile/pitches");
    return { result: "saved" };
  } catch {
    return { result: "error" };
  }
}

export async function archivePitchTemplateAction(formData: FormData): Promise<PitchActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };
  const templateId = readField(formData, "templateId");
  if (!/^[0-9a-f-]{36}$/i.test(templateId)) {
    return { result: "invalid_input", message: "That template is not available." };
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("pitch_templates")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", templateId)
      .is("archived_at", null)
      .select("id")
      .maybeSingle();
    if (error) return { result: "error" };
    if (!data) return { result: "not_found" };
    revalidatePath("/app/profile/pitches");
    return { result: "archived" };
  } catch {
    return { result: "error" };
  }
}

export async function savePitchDraftAction(formData: FormData): Promise<PitchActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const parsed = parsePitchDraftFields({
    hotelId: readField(formData, "hotelId"),
    draftId: readField(formData, "draftId"),
    tripId: readField(formData, "tripId"),
    templateId: readField(formData, "templateId"),
    systemKey: readField(formData, "systemKey"),
    subject: readField(formData, "subject"),
    body: readField(formData, "body"),
    opportunityId: readField(formData, "opportunityId"),
  });
  if (!parsed.ok) return { result: "invalid_input", message: parsed.message };

  const hotel = await getHotelById(parsed.hotelId);
  if (!hotel) return { result: "not_found" };

  const context = await loadPitchContext({
    userId: resolution.session.userId,
    hotelId: parsed.hotelId,
    hotelName: hotel.hotel.name,
    destinationName: hotel.hotel.destination?.name ?? null,
    requestedTripId: parsed.tripId,
    preferDraftTrip: false,
    requestedPipelineItemId: parsed.opportunityId,
  });
  if (context.status !== "ok") return { result: "error" };
  if (
    context.opportunityChoice === "many" ||
    context.opportunityChoice === "missing" ||
    context.opportunityChoice === "trip_empty"
  ) {
    return { result: "invalid_input", message: "Choose one of your opportunities." };
  }
  const boundId = context.selectedOpportunity?.id ?? null;
  if (parsed.opportunityId && boundId !== parsed.opportunityId) {
    return { result: "invalid_input", message: "Choose one of your opportunities." };
  }
  const storedTrip = pitchTripToStore({
    opportunity: context.selectedOpportunity,
    requestedTripId: parsed.tripId,
    ownedTripId: context.selectedTripId,
  });
  if (!storedTrip.ok) return { result: "invalid_input", message: storedTrip.message };
  if (
    parsed.templateId &&
    !context.templates.some((template) => template.id === parsed.templateId)
  ) {
    return { result: "invalid_input", message: "Choose one of your templates." };
  }

  const row = {
    hotel_id: parsed.hotelId,
    trip_id: storedTrip.tripId,
    template_id: parsed.templateId,
    system_template_key: parsed.systemKey,
    subject: parsed.subject,
    body: parsed.body,
    variables_used: factKeys(context.facts),
  };

  const write = resolveOpportunityDraftWrite({
    postedDraftId: parsed.draftId,
    loadedDraftId: context.draft?.id ?? null,
    loadedOpportunityId: context.draft?.pipelineItemId ?? null,
    boundOpportunityId: boundId,
  });
  if (write.action === "reject") {
    return {
      result: "invalid_input",
      message: "That draft belongs to a different opportunity.",
    };
  }

  try {
    const supabase = await createClient();
    if (write.action === "update") {
      const loadedBound =
        context.draft?.id === write.draftId &&
        boundId !== null &&
        context.draft.pipelineItemId === boundId;
      if (!loadedBound) {
        const existing = await supabase
          .from("pitch_drafts")
          .select("id, pipeline_item_id")
          .eq("id", write.draftId)
          .eq("hotel_id", parsed.hotelId)
          .maybeSingle();
        if (existing.error) return { result: "error" };
        if (!existing.data) return { result: "not_found" };
        const current =
          typeof existing.data.pipeline_item_id === "string"
            ? existing.data.pipeline_item_id
            : null;
        if (current !== boundId) {
          return {
            result: "invalid_input",
            message: "That draft belongs to a different opportunity.",
          };
        }
      }
      const { data, error } = await supabase
        .from("pitch_drafts")
        .update(row)
        .eq("id", write.draftId)
        .eq("hotel_id", parsed.hotelId)
        .select("id")
        .maybeSingle();
      if (error) return { result: "error" };
      if (!data) return { result: "not_found" };
      revalidatePath(`/app/hotels/${parsed.hotelId}/pitch`);
      return { result: "saved", draftId: write.draftId };
    }

    const { data, error } = await supabase
      .from("pitch_drafts")
      .insert({ ...row, pipeline_item_id: boundId })
      .select("id")
      .single();
    if (error || !data?.id) return { result: "error" };
    revalidatePath(`/app/hotels/${parsed.hotelId}/pitch`);
    return { result: "saved", draftId: String(data.id) };
  } catch {
    return { result: "error" };
  }
}

export async function recordPitchDeliveryAction(formData: FormData): Promise<PitchActionResult> {
  const resolution = await resolveSession();
  if (resolution.status !== "authenticated") return { result: "error" };

  const delivery = parseDelivery(readField(formData, "delivery"));
  if (typeof delivery !== "string") return { result: "invalid_input", message: delivery.message };
  const draftId = readField(formData, "draftId");
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) {
    return { result: "invalid_input", message: "Save the draft first." };
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("pitch_drafts")
      .update({ delivery })
      .eq("id", draftId)
      .select("id, hotel_id")
      .maybeSingle();
    if (error) return { result: "error" };
    if (!data) return { result: "not_found" };
    const hotelId = typeof data.hotel_id === "string" ? data.hotel_id : null;
    if (hotelId) revalidatePath(`/app/hotels/${hotelId}/pitch`);
    return { result: "recorded" };
  } catch {
    return { result: "error" };
  }
}
